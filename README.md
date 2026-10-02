# Trazo · Anotador de imágenes

Web local para subir una imagen desde el PC, abrir su QR en Safari en el iPad y anotar con Apple Pencil. Ambos dispositivos trabajan sobre la misma sesión. No requiere una app nativa ni servicios externos para anotar.

## Iniciar

Descarga o clona este repositorio y abre su carpeta. En Windows, haz doble clic en **Iniciar.cmd**, o ejecuta desde PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Iniciar.ps1
```

El lanzador abre http://localhost:8795 y mantiene el servidor en segundo plano. Los registros están en `server.log` y `server-error.log`. Necesita Python 3.10+; la primera instalación descarga las dependencias en `.venv`.

## Uso

1. En el PC, arrastra una imagen, selecciónala o pega una captura con Ctrl+V.
2. Escanea el QR con la cámara del iPad y abre el enlace en Safari. PC e iPad deben estar en la misma red, con acceso entre dispositivos.
3. En el iPad, el lápiz está activo directamente y los paneles empiezan plegados. **Herramientas** abre lápiz, flechas, rectángulos, notas, colores y deshacer. **Comentarios** abre las instrucciones. Toda la superficie central permite escribir, dentro y fuera de la imagen. En **Solo Pencil**, usa dos dedos para desplazar y ampliar; un dedo o la palma no mueve el lienzo. En el PC puedes activar **Editar aquí** y usar el ratón.
4. Los trazos se transmiten al PC durante el movimiento mediante WebSocket. Los cambios se guardan automáticamente tras una pausa de 350 ms; la consulta cada dos segundos sirve de respaldo si se interrumpe el canal en directo. El QR se cierra al detectar un editor conectado con la vista de iPad. Las notas numeradas vuelven al lápiz tras colocarlas y no fuerzan el foco, el teclado ni el desplazamiento al panel.
5. **Listo para el agente** guarda la sesión y genera el ZIP en el PC. **Descargar paquete** devuelve original, base orientada, imagen anotada, instrucciones Markdown y anotaciones JSON. **Copiar mensaje para el agente** facilita el texto que acompañará al paquete; no envía mensajes a ningún agente.

Mantén Safari abierto y el PC encendido mientras anotas. La vista del PC es de lectura inicialmente. Evita editar simultáneamente desde dos ventanas: el control de versiones rechaza una escritura obsoleta, conserva el borrador local y permite descargarlo.

## Datos

Las sesiones se guardan en `data/sessions.sqlite3`; los archivos en `data/<id-de-sesión>/`. El archivo original se conserva byte a byte. El lienzo usa una copia PNG orientada y limitada a 4096 px por lado. Las coordenadas de las anotaciones son relativas a esa imagen y admiten valores negativos para escribir fuera de ella, hasta ±16384 px por eje. La exportación incluye todas las marcas; si es necesario, reduce el resultado a 8192 px por lado y 24 megapíxeles. GIF utiliza el primer fotograma. Tamaño máximo de subida: 25 MB; máximo de imagen: 45 millones de píxeles. Las exportaciones se conservan en la carpeta de la sesión cuando se generan; el estado editable actual se guarda en SQLite. Las sesiones existentes conservan sus coordenadas y anotaciones.

Los enlaces contienen un identificador aleatorio de 128 bits. Cualquier persona con el enlace y acceso a la red puede ver y editar esa sesión. No publiques este servidor directamente en Internet; el despliegue externo, autenticación y HTTPS quedan para la siguiente etapa. La portada recuerda en ese navegador sus últimas 30 sesiones, sin publicar un listado de todas las sesiones.

## Conexión del iPad

La dirección LAN se calcula al iniciar el servidor y aparece en el QR. Si cambia la IP del PC, reinicia el servidor. Para una interfaz concreta, puedes definir `ANNOTATOR_BASE_URL` con la dirección de ese equipo y el puerto, siguiendo el formato `http://<IP-DEL-PC>:8795`.

Si Safari no conecta, revisa que no sea una red Wi-Fi de invitados con aislamiento y que Windows permita TCP 8795 desde la red local. El funcionamiento real de Apple Pencil, los gestos y el rechazo de palma debe comprobarse en el iPad físico.

## Desarrollo

Instalación manual desde la carpeta del proyecto:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
.\.venv\Scripts\python.exe server.py
```

Backend FastAPI, SQLite y Pillow; interfaz HTML/CSS/JavaScript sin compilación ni recursos de terceros. La copia al portapapeles incluye una alternativa para HTTP local. El servidor escucha en todas las interfaces en el puerto 8795. Para detenerlo, identifica primero el proceso con `Get-NetTCPConnection -LocalPort 8795 -State Listen` y detén solo ese proceso.

`requirements-lock.txt` contiene las versiones instaladas y comprobadas. `tools/verify.py` comprueba subida, guardado, conflicto de versiones, conservación del original, QR, exportación fuera de la imagen, validación de coordenadas, presencia de iPad y transmisión de trazos antes del guardado; genera una imagen de ejemplo y una sesión de comprobación. La interfaz se comprobó con dos vistas de navegador, verificando el cierre del QR, la llegada de notas al PC antes del guardado y que una nota no enfoca campos ni desplaza la página. Se revisaron tamaños 1024×768 y 768×1024 sin desbordamiento de página. La prueba del Pencil y los gestos en el iPad físico debe confirmarse allí.

Después de actualizar la aplicación, recarga Safari en el iPad y la página del PC cuando aparezca **Guardado en el PC**, para cargar el nuevo editor. Los enlaces antiguos siguen funcionando; los QR nuevos añaden `surface=tablet` para abrir directamente la interfaz compacta.

El botón **Ver todo** encuadra imagen y anotaciones exteriores. En el PC ese es el encuadre inicial. **Vista del agente** muestra el PNG completo que se incluye en el paquete, con todas las marcas guardadas; el mensaje copiado recuerda al agente leer también las notas de los márgenes.

## Contenido del repositorio

Se distribuyen únicamente el código, los lanzadores, las dependencias y la documentación. No se incluyen imágenes de usuarios, sesiones, anotaciones, bases de datos ni registros. `.gitignore` permite solo los archivos de código revisados; para añadir un archivo nuevo al repositorio hay que incorporarlo explícitamente a esa lista. Los datos creados al usar la aplicación permanecen en la carpeta local `data/`.
