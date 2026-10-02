"""Local image annotator: shared PC/iPad sessions with no external services."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import math
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import threading
import time
import warnings
import zipfile

from fastapi import FastAPI, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field
import qrcode

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
DATA.mkdir(exist_ok=True)
PORT = int(os.environ.get('ANNOTATOR_PORT', '8795'))
DB = DATA / 'sessions.sqlite3'
LOCK = threading.RLock()
MAX_UPLOAD = 25 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 45_000_000


def connection():
    conn = sqlite3.connect(DB, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


with connection() as conn:
    conn.execute('''CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, width INTEGER, height INTEGER,
      original_ext TEXT NOT NULL, annotations TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'editing', created REAL, updated REAL,
      editor_seen REAL NOT NULL DEFAULT 0)''')


def lan_ip():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.connect(('192.0.2.1', 80))
            return sock.getsockname()[0]
        except OSError:
            return '127.0.0.1'


BASE_URL = os.environ.get('ANNOTATOR_BASE_URL', f'http://{lan_ip()}:{PORT}').rstrip('/')
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
PEERS: dict[str, dict] = {}
WORLD_LIMIT = 16384


def publish(sid, message):
    for peer in tuple(PEERS.get(sid, {}).values()):
        queue = peer['queue']
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(message)


def presence(sid):
    publish(sid, {'type': 'presence', 'peers': [
        {'client': client, 'tablet': peer['tablet'], 'editing': peer['editing']}
        for client, peer in PEERS.get(sid, {}).items()
    ]})


@app.middleware('http')
async def same_origin(request: Request, call_next):
    origin = request.headers.get('origin')
    if request.method not in ('GET', 'HEAD', 'OPTIONS') and origin:
        if origin.rstrip('/') != f'{request.url.scheme}://{request.headers.get("host", "")}':
            return Response('Origin not allowed', status_code=403)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Cache-Control'] = 'no-store'
    return response


def get_session(sid):
    if len(sid) != 32 or any(c not in '0123456789abcdef' for c in sid):
        raise HTTPException(404, 'Session not found')
    with connection() as conn:
        row = conn.execute('SELECT * FROM sessions WHERE id=?', (sid,)).fetchone()
    if row is None:
        raise HTTPException(404, 'Session not found')
    result = dict(row)
    result['annotations'] = json.loads(result['annotations'])
    result['url'] = f'{BASE_URL}/s/{sid}?mode=edit&surface=tablet'
    result['editor_online'] = time.time() - result['editor_seen'] < 15
    return result


@app.get('/api/info')
def info():
    return {'url': BASE_URL, 'data_path': str(DATA), 'port': PORT}


@app.post('/api/sessions')
async def create_session(file: UploadFile):
    raw = await file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, 'The image exceeds the 25 MB limit.')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            original = Image.open(io.BytesIO(raw))
            fmt = original.format
            if fmt not in ('PNG', 'JPEG', 'WEBP', 'GIF', 'BMP'):
                raise HTTPException(415, 'Use PNG, JPEG, WebP, GIF, or BMP.')
            img = ImageOps.exif_transpose(original).convert('RGBA')
            img.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(415, 'The image cannot be read or is too large.')
    sid = secrets.token_hex(16)
    folder = DATA / sid
    folder.mkdir()
    ext = {'PNG': 'png', 'JPEG': 'jpg', 'WEBP': 'webp', 'GIF': 'gif', 'BMP': 'bmp'}[fmt]
    (folder / f'original.{ext}').write_bytes(raw)
    img.save(folder / 'base.png')
    title = (file.filename or 'Image').replace('\\', '/').split('/')[-1][:160]
    now = time.time()
    with connection() as conn:
        conn.execute('INSERT INTO sessions (id,title,width,height,original_ext,created,updated) VALUES (?,?,?,?,?,?,?)',
                     (sid, title, img.width, img.height, ext, now, now))
    return get_session(sid)


@app.get('/api/sessions/{sid}')
def read_session(sid: str):
    return get_session(sid)


@app.get('/api/sessions/{sid}/image')
def session_image(sid: str):
    get_session(sid)
    return FileResponse(DATA / sid / 'base.png', media_type='image/png')


@app.get('/api/sessions/{sid}/qr')
def qr(sid: str):
    session = get_session(sid)
    image = qrcode.make(session['url'], box_size=8, border=3)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return Response(buffer.getvalue(), media_type='image/png')


@app.post('/api/sessions/{sid}/heartbeat')
def heartbeat(sid: str):
    get_session(sid)
    with connection() as conn:
        conn.execute('UPDATE sessions SET editor_seen=? WHERE id=?', (time.time(), sid))
    return {'ok': True}


class Annotation(BaseModel):
    kind: str = Field(pattern=r'^(pen|arrow|rect|pin)$')
    color: str = Field(pattern=r'^#[0-9a-fA-F]{6}$')
    width: float = Field(ge=0.1, le=200)
    points: list[tuple[float, float]] = Field(min_length=1, max_length=25000)
    text: str = Field(default='', max_length=4000)


class Update(BaseModel):
    version: int = Field(ge=0)
    annotations: list[Annotation] = Field(max_length=2000)
    notes: str = Field(max_length=40000)
    status: str = Field(pattern=r'^(editing|ready)$')


def validate_coordinates(annotations):
    for annotation in annotations:
        for x, y in annotation.points:
            if not math.isfinite(x) or not math.isfinite(y) or not (-WORLD_LIMIT <= x <= WORLD_LIMIT and -WORLD_LIMIT <= y <= WORLD_LIMIT):
                raise ValueError('Coordinates are outside the workspace.')


@app.websocket('/api/sessions/{sid}/live')
async def live_session(socket: WebSocket, sid: str):
    origin = socket.headers.get('origin', '')
    if origin and origin.split('://', 1)[-1] != socket.headers.get('host'):
        await socket.close(code=1008)
        return
    try:
        get_session(sid)
    except HTTPException:
        await socket.close(code=1008)
        return
    client = socket.query_params.get('client', '')
    if len(client) < 12 or len(client) > 80:
        await socket.close(code=1008)
        return
    await socket.accept()
    peer = {'queue': asyncio.Queue(maxsize=16), 'tablet': False, 'editing': False}
    PEERS.setdefault(sid, {})[client] = peer

    async def writer():
        while True:
            await asyncio.wait_for(socket.send_json(await peer['queue'].get()), timeout=5)

    writer_task = asyncio.create_task(writer())
    presence(sid)
    try:
        while True:
            raw = await socket.receive_text()
            if len(raw) > 12 * 1024 * 1024:
                await socket.close(code=1009)
                break
            try:
                event = json.loads(raw)
                kind = event.get('type')
                if kind == 'hello':
                    peer['tablet'] = event.get('tablet') is True
                    peer['editing'] = event.get('editing') is True
                    presence(sid)
                elif kind == 'stroke' and peer['editing']:
                    stroke = Annotation.model_validate(event['stroke']) if event.get('stroke') else None
                    if stroke:
                        validate_coordinates([stroke])
                    publish(sid, {'type': 'stroke', 'client': client, 'version': int(event['version']),
                                  'stroke': stroke.model_dump() if stroke else None})
                elif kind == 'draft' and peer['editing']:
                    update = Update.model_validate(event['draft'])
                    validate_coordinates(update.annotations)
                    publish(sid, {'type': 'draft', 'client': client, 'draft': update.model_dump()})
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
    except WebSocketDisconnect:
        pass
    finally:
        writer_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await writer_task
        if PEERS.get(sid, {}).get(client) is peer:
            PEERS[sid].pop(client, None)
        presence(sid)
        if not PEERS.get(sid):
            PEERS.pop(sid, None)


@app.put('/api/sessions/{sid}')
async def update_session(sid: str, request: Request):
    # Bound JSON size before parsing, including requests without Content-Length.
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 12 * 1024 * 1024:
            raise HTTPException(413, 'Too many annotations in this session.')
    try:
        update = Update.model_validate_json(raw)
    except ValueError:
        raise HTTPException(422, 'Invalid annotation format.')
    with LOCK:
        session = get_session(sid)
        try:
            validate_coordinates(update.annotations)
        except ValueError as error:
            raise HTTPException(422, str(error))
        if update.version != session['version']:
            raise HTTPException(409, 'This session was changed in another window. Your local changes are still in this browser. Download your draft before reloading.')
        with connection() as conn:
            conn.execute('UPDATE sessions SET annotations=?,notes=?,status=?,version=version+1,updated=? WHERE id=?',
                         (json.dumps([a.model_dump() for a in update.annotations], ensure_ascii=False),
                          update.notes, update.status, time.time(), sid))
        saved = get_session(sid)
        publish(sid, {'type': 'saved', 'client': request.headers.get('x-trazo-client', ''), 'session': saved})
        return saved


def font(size):
    for name in ('C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default(size=size)


def export_bounds(session):
    left, top, right, bottom = 0, 0, session['width'], session['height']
    for annotation in session['annotations']:
        padding = max(annotation['width'] * 5, session['width'] * .025, 24)
        for x, y in annotation['points']:
            left, top = min(left, x-padding), min(top, y-padding)
            right, bottom = max(right, x+padding), max(bottom, y+padding)
    return [math.floor(left), math.floor(top), math.ceil(right), math.ceil(bottom)]


def annotated_png(session):
    left, top, right, bottom = export_bounds(session)
    scale = min(1, 8192 / max(right-left, bottom-top), math.sqrt(24_000_000 / ((right-left)*(bottom-top))))
    size = (max(1, math.ceil((right-left)*scale)), max(1, math.ceil((bottom-top)*scale)))
    image = Image.new('RGB', size, 'white')
    with Image.open(DATA / session['id'] / 'base.png') as base:
        if scale < 1:
            base = base.resize((max(1, round(base.width*scale)), max(1, round(base.height*scale))), Image.Resampling.LANCZOS)
        image.paste(base, (round(-left*scale), round(-top*scale)), mask=base.getchannel('A'))
    draw = ImageDraw.Draw(image)
    pin = 0
    for a in session['annotations']:
        points = [((x-left)*scale, (y-top)*scale) for x, y in a['points']]
        color, width = a['color'], max(1, round(a['width']*scale))
        x, y = points[0]
        end = points[-1]
        if a['kind'] == 'pen':
            if len(points) > 1:
                draw.line(points, fill=color, width=width, joint='curve')
            r = width / 2
            for px, py in (points[0], points[-1]):
                draw.ellipse((px-r, py-r, px+r, py+r), fill=color)
        elif a['kind'] == 'rect':
            draw.rectangle((min(x, end[0]), min(y, end[1]), max(x, end[0]), max(y, end[1])), outline=color, width=width)
        elif a['kind'] == 'arrow':
            draw.line([points[0], end], fill=color, width=width)
            angle = math.atan2(end[1]-y, end[0]-x)
            length = max(width * 4, session['width'] * .018 * scale)
            tips = [(end[0]-length*math.cos(angle+d), end[1]-length*math.sin(angle+d)) for d in (-.5, .5)]
            draw.polygon([end, *tips], fill=color)
        elif a['kind'] == 'pin':
            pin += 1
            r = max(12, session['width'] * .014) * scale
            draw.ellipse((x-r,y-r,x+r,y+r), fill=color, outline='white', width=max(1, round(r/8)))
            draw.text((x,y), str(pin), fill='white', font=font(round(r*1.2)), anchor='mm')
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def instructions(session):
    lines = ['# Requested changes', '', f"Image: {session['title']}",
             f"Status: {'Ready for agent' if session['status'] == 'ready' else 'Draft'}",
             f"Reference image: {session['width']} × {session['height']} px",
             f"Export bounds [left, top, right, bottom]: {export_bounds(session)}",
             'Coordinates are relative to the top-left corner of base.png. Negative values are outside the image.', '',
             '## General instructions', '', session['notes'] or '(No general instructions)', '', '## Numbered areas', '']
    pins = [a for a in session['annotations'] if a['kind'] == 'pin']
    for i, a in enumerate(pins, 1):
        x, y = a['points'][0]
        lines += [f"### Area {i} · x={round(x)}, y={round(y)}", '', a['text'] or '(No comment)', '']
    if not pins:
        lines += ['(No numbered areas)', '']
    lines += ['## Reference files', '',
              '- original: the uploaded file, unchanged.',
              '- base.png: the oriented image, resized to a maximum of 4096 px per side; the coordinate reference.',
              '- annotated.png: the image and all annotations, including those outside the image. Large exports are limited to 8192 px per side and 24 megapixels.',
              '- annotations.json: editable strokes, areas, and comments.', '',
              'Review both visual annotations and comments before applying changes.', '']
    return '\n'.join(lines)


@app.get('/api/sessions/{sid}/export/{kind}')
def export(sid: str, kind: str):
    session = get_session(sid)
    folder = DATA / sid
    if kind == 'png':
        payload, mime, filename = annotated_png(session), 'image/png', 'annotated.png'
    elif kind == 'md':
        payload, mime, filename = instructions(session).encode('utf-8'), 'text/markdown; charset=utf-8', 'instructions.md'
    elif kind == 'zip':
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            original_name = f"original.{session['original_ext']}"
            archive.write(folder / original_name, original_name)
            archive.write(folder / 'base.png', 'base.png')
            archive.writestr('annotated.png', annotated_png(session))
            archive.writestr('instructions.md', instructions(session))
            archive.writestr('annotations.json', json.dumps({k: session[k] for k in ('id','title','width','height','version','status','annotations','notes')}, ensure_ascii=False, indent=2))
        payload, mime, filename = buffer.getvalue(), 'application/zip', f'annotations-{sid[:8]}.zip'
    else:
        raise HTTPException(404)
    # Keep a concrete export on the PC as well as returning the browser download.
    with LOCK:
        target = folder / filename
        temporary = folder / f'{filename}.tmp'
        temporary.write_bytes(payload)
        temporary.replace(target)
    return Response(payload, media_type=mime, headers={'Content-Disposition': f'attachment; filename="{filename}"'})


@app.get('/')
@app.get('/s/{sid}')
def page(sid: str | None = None):
    if sid:
        get_session(sid)
    return FileResponse(ROOT / 'static' / 'index.html')


app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')

if __name__ == '__main__':
    import uvicorn
    print(f'PC: http://localhost:{PORT} | iPad: {BASE_URL}', flush=True)
    uvicorn.run(app, host='0.0.0.0', port=PORT)
