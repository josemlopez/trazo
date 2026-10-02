"""Integration checks against the running local server."""
import asyncio
import io
import json
from pathlib import Path
import urllib.request
import urllib.error
import zipfile
import websockets
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:8795'
image = Image.new('RGB', (1200, 800), '#f6f3eb')
draw = ImageDraw.Draw(image)
def font(size):
    for name in ('C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'):
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default(size=size)
draw.rectangle((0,0,1200,85), fill='#284537')
draw.text((45,22),'STUDIO / Example page',font=font(30),fill='white')
draw.text((70,160),'A space for your ideas',font=font(52),fill='#284537')
draw.text((73,240),'Try your Pencil: mark a change and add a note.',font=font(25),fill='#768174')
draw.rounded_rectangle((75,320,390,400),radius=16,fill='#e45e3d')
draw.text((122,342),'Start a project',font=font(26),fill='white')
for x, text in [(75,'Design'),(435,'Content'),(795,'Details')]:
    draw.rounded_rectangle((x,475,x+325,705),radius=18,fill='white',outline='#d9dfd1',width=2)
    draw.text((x+25,510),text,font=font(28),fill='#284537')
    draw.line((x+25,575,x+285,575),fill='#e1e6db',width=10)
    draw.line((x+25,610,x+220,610),fill='#e1e6db',width=10)
examples = ROOT/'examples'
examples.mkdir(exist_ok=True)
image.save(examples/'example-page.png')
raw = (examples/'example-page.png').read_bytes()
boundary='trazo-verification-boundary'
body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="Verification.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+raw+f'\r\n--{boundary}--\r\n'.encode())
def call(path, data=None, method=None, headers=None):
    request=urllib.request.Request(BASE+path,data=data,method=method,headers=headers or {})
    with urllib.request.urlopen(request,timeout=20) as response:
        return response.read()
session=json.loads(call('/api/sessions',body,'POST',{'Content-Type':f'multipart/form-data; boundary={boundary}'}))
sid=session['id']
assert (session['width'],session['height'])==(1200,800)
update={'version':0,'notes':'Make the main button larger.','status':'ready','annotations':[
    {'kind':'pen','color':'#ea5b38','width':5,'points':[[50,50],[100,100],[150,75]],'text':''},
    {'kind':'arrow','color':'#367bf5','width':5,'points':[[500,350],[400,350]],'text':''},
    {'kind':'rect','color':'#25986a','width':5,'points':[[70,310],[400,410]],'text':''},
    {'kind':'pin','color':'#ea5b38','width':5,'points':[[230,350]],'text':'Make this button larger.'}
]}
saved=json.loads(call(f'/api/sessions/{sid}',json.dumps(update).encode(),'PUT',{'Content-Type':'application/json'}))
assert saved['version']==1 and saved['annotations'][3]['text']==update['annotations'][3]['text']
try:
    call(f'/api/sessions/{sid}',json.dumps(update).encode(),'PUT',{'Content-Type':'application/json'})
    raise AssertionError('An outdated revision was accepted')
except urllib.error.HTTPError as error:
    assert error.code==409
bundle=call(f'/api/sessions/{sid}/export/zip')
with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
    assert archive.read('original.png')==raw
    assert len(archive.namelist())==5
    assert 'Make the main button' in archive.read('instructions.md').decode()
    annotated=Image.open(io.BytesIO(archive.read('annotated.png')))
    assert annotated.size==(1200,800)
    assert annotated.getpixel((90,90))!=(image.getpixel((90,90)))
qr=Image.open(io.BytesIO(call(f'/api/sessions/{sid}/qr')))
assert qr.width>100
invalid={**update,'version':1,'annotations':[dict(update['annotations'][0],points=[[-17000,10]])]}
try:
    call(f'/api/sessions/{sid}',json.dumps(invalid).encode(),'PUT',{'Content-Type':'application/json'})
    raise AssertionError('Out-of-bounds coordinates were accepted')
except urllib.error.HTTPError as error:
    assert error.code==422
outside=dict(update['annotations'][0],points=[[-200,-100],[-100,-100]])
outside_update={**update,'version':1,'annotations':update['annotations']+[outside]}
json.loads(call(f'/api/sessions/{sid}',json.dumps(outside_update).encode(),'PUT',{'Content-Type':'application/json'}))
expanded=Image.open(io.BytesIO(call(f'/api/sessions/{sid}/export/png')))
assert expanded.width>1200 and expanded.height>800
assert expanded.getpixel((75,30))==(234,91,56), 'Annotations outside the image are missing from the export'

async def receive_type(socket, kind):
    async with asyncio.timeout(5):
        while True:
            message=json.loads(await socket.recv())
            if message['type']==kind:
                return message

async def check_live():
    url=f'ws://127.0.0.1:8795/api/sessions/{sid}/live'
    async with websockets.connect(url+'?client=verification-pc-1234') as pc:
        await pc.send(json.dumps({'type':'hello','tablet':False,'editing':False}))
        async with websockets.connect(url+'?client=verification-ipad-1234') as ipad:
            await ipad.send(json.dumps({'type':'hello','tablet':True,'editing':True}))
            async with asyncio.timeout(5):
                while True:
                    presence=await receive_type(pc,'presence')
                    if any(p['tablet'] and p['editing'] for p in presence['peers']):break
            await ipad.send(json.dumps({'type':'stroke','version':2,'stroke':outside}))
            event=await receive_type(pc,'stroke')
            assert event['stroke']['points'][0]==[-200,-100]
            assert json.loads(await asyncio.to_thread(call,f'/api/sessions/{sid}'))['version']==2, 'Live strokes must not create a saved revision for every movement'
            draft={**outside_update,'version':2,'notes':'Live from iPad'}
            await ipad.send(json.dumps({'type':'draft','draft':draft}))
            assert (await receive_type(pc,'draft'))['draft']['notes']==draft['notes']
            await asyncio.to_thread(call,f'/api/sessions/{sid}',json.dumps(draft).encode(),'PUT',{'Content-Type':'application/json','X-Trazo-Client':'verification-ipad-1234'})
            assert (await receive_type(pc,'saved'))['session']['version']==3
        async with asyncio.timeout(5):
            while True:
                event=await receive_type(pc,'presence')
                if not any(p['tablet'] for p in event['peers']):break

asyncio.run(check_live())
print(json.dumps({'result':'PASS','checks':['upload','autosave','optimistic_conflict','export_zip','original_preserved','png_render','qr','invalid_coordinates','outside_image_export','live_stroke_before_save','live_draft','saved_broadcast','tablet_presence_and_disconnect'],'session':sid,'sample':str(examples/'example-page.png')},ensure_ascii=False))

