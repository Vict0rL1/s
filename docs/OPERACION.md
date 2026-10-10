# Operación

Puesta en marcha, diagnóstico (`npm run doctor`), despliegue, el teléfono, los trabajos programados (`npm run jobs`), métricas y exportaciones.

## Fase 3: salud, métricas, trabajos y exportaciones

- `GET /health` y `GET /healthz` (vive) y `GET /ready` (migraciones al día y registro de trabajos en
  marcha; 503 si no), sin contraseña. Fly y `docker-compose.yml` los usan.
- `GET /api/metrics` (detrás de la contraseña): formato texto de Prometheus — peticiones por grupo
  de ruta y código, predicciones servidas por deporte, apuestas de papel, señales, snapshots,
  cuota de The Odds API usada y restante, errores en 24 h, duración y ejecuciones de cada trabajo.
- Logs: pino (una línea JSON por evento) con `reqId`; nivel con `LOG_LEVEL`; nunca se escriben la
  cabecera de autorización ni las cookies.
- Trabajos programados: `GET /api/scheduler` y `npm run jobs` enseñan la lista (puntuar en vivo,
  pre-partido, copia del libro mayor, resultados, clima, bullpen, cierre de cuotas) con cadencia,
  última ejecución, duración y estado; `PATCH /api/scheduler/<nombre> {"enabled": false}` apaga
  uno sin reiniciar; `POST /api/scheduler/<nombre>/ejecutar` lo lanza ahora.
- Exportaciones: `GET /api/export/<predicciones|apuestas|papel|snapshots|benchmark>?formato=csv|json&desde&hasta&sport`
  y `npm run export -- <conjunto> [--formato csv] [--desde] [--hasta] [--sport] [--salida fichero]`.
- `npm run help` (todos los comandos, por grupo), `npm run setup` (asistente de primera puesta en
  marcha) y `docker-compose.yml` para uso local.

## Los tres comandos

Todo lo demás de este README es detalle. Esto es lo que se escribe:

```bash
cd ~/s           # ← PRIMERO ESTO. La terminal se abre en tu carpeta personal,
                 #   no en la del proyecto, y ahí npm no encuentra nada.
npm run go       # abrir y actualizar la app. El único que hace falta saber.
```

Los otros dos, ya dentro de la carpeta:

```bash
npm run odds     # pedir las cuotas reales, cuando salen «de demostración».
npm run phone    # abrirla en el móvil, en la misma wifi.
```

> **Si escribes `npm run go` y no pasa nada**, o sale un error largo que empieza por
> `npm error`, casi siempre es que falta el `cd`. La terminal siempre arranca en tu
> carpeta personal (`~`), y `npm run go` solo existe dentro del proyecto. Esta línea lo
> dice sin margen de duda — pégala tal cual y lee la última palabra:
>
> ```bash
> pwd && ls package.json >/dev/null 2>&1 && echo "ESTÁS DENTRO" || echo "NO estás dentro"
> ```
>
> Si el proyecto no está en `~/s`, esta línea lo encuentra esté donde esté:
> ```bash
> find ~ -maxdepth 4 -name go.mjs -path '*/scripts/*' 2>/dev/null
> ```
> Te contesta algo como `/Users/tu-nombre/s/scripts/go.mjs`: la carpeta a la que hay que
> entrar es esa sin `/scripts/go.mjs`, o sea `cd /Users/tu-nombre/s`.
>
> **El atajo que nunca falla en un Mac:** escribe `cd ` (con el espacio), **arrastra la
> carpeta del proyecto desde el Finder hasta la ventana de la Terminal** y suelta. La ruta
> se escribe sola, correcta y sin faltas. Pulsa Enter y ya estás dentro.
>
> Y si no quieres acordarte de nada: **doble clic en `scripts/abrir.command`** desde el
> Finder. Hace lo mismo que `npm run go` y se encarga del `cd` él solo — incluso encuentra
> Node cuando lo instalaste con nvm, que es donde el doble clic suele fallar. Ver
> [«Abrirla sin escribir nada»](#abrirla-sin-escribir-nada-scriptsabrircommand).

**`npm run go`** hace todo: se pone en la rama correcta, se trae los cambios, instala lo
que falte, comprueba la base de datos y arranca. Si algo no está, lo dice y dice cómo se
arregla en vez de fallar a secas. Sirve igual para abrirla y para actualizarla — es el
mismo comando las dos veces. Detalle en [«Un solo comando»](#un-solo-comando-npm-run-go).

**`npm run odds`** es para una sola cosa: la app dice «cuotas de demostración» y quieres
las de verdad. Pide las de los siete deportes y dice, deporte a deporte, si han llegado y
—cuando no— por qué. Cuesta cinco peticiones del plan y lo avisa antes de gastarlas.
Detalle en [«Quiero las cuotas reales»](#quiero-las-cuotas-reales-npm-run-odds).

> **El caso que más despista:** pones la clave en el `.env`, reinicias, y la app sigue
> diciendo demo. No está rota. Las cuotas guardadas se bajaron **antes** de que hubiera
> clave, y nada las vuelve a pedir solo por reiniciar. `npm run odds` las pide. Desde esta
> versión `npm run go` detecta justo ese caso y lo dice con el comando al lado.

Y si algo sigue sin cuadrar, **`npm run doctor`** diagnostica sin gastar ni una petición.

**«¿Acertó?» (arriba de cada pestaña)** enseña los partidos de los últimos 7, 14 o 30 días:
los que la app registró antes de jugarse (**en vivo**) y, para no quedarse en una muestra
de 19, el resto de partidos jugados del archivo con la predicción **reconstruida** por el
modelo del backtest, solo con datos anteriores a cada partido (`server/src/recent/`). Los
dos se cuentan por separado y un partido nunca dos veces. Si salen días vacíos es casi
siempre el archivo de resultados sin actualizar; se ponen al día los cuatro deportes de
equipo de una vez, sin gastar créditos de cuotas, con:

```bash
npm run update-results
```

### El modelo apostando solo: 1.000 $ de papel

En la pestaña de Apuestas, separado de tu propio registro. El modelo arranca con 1.000 $
y apuesta por su cuenta, con la misma política que la app recomienda: **Kelly a un
cuarto, 2 % máximo por evento** y topes de exposición por día y totales. No es dinero
real y no es una recomendación — es la única forma de contestar a la pregunta que importa
de un modelo de apuestas: *si le hubiera hecho caso, ¿cuánto habría ganado?*

**La trampa que hay que desactivar antes que nada.** Cuatro de los cinco deportes se
inventan las cuotas cuando no llegan las reales, y las inventan a partir del propio
modelo con un margen encima. Apostar contra esas cuotas es apostar contra uno mismo: el
modelo encontraría «valor» en su propio precio, la diferencia sería el margen que él
mismo puso, y el banco subiría de forma constante **por construcción**. Un 1.000 → 1.400
así no dice nada del modelo; dice que sabe sumar.

Así que el banco **se niega a apostar sobre cualquier cuota de demostración**, y cuando
no hay ninguna real lo dice en vez de dar números:

> **Todavía no ha apostado nada.** No hay ningún partido con cuotas reales por delante.
> Con cuotas de demostración este banco no apuesta: el modelo encontraría valor en su
> propio precio y el resultado no diría nada.

**Un banco quieto tiene que poder explicarse.** Tres semanas sin apostar se ven idénticas
en los tres casos que las producen, y cada uno pide algo distinto:

| Lo que pasa | Lo que dice | Qué hacer |
| --- | --- | --- |
| No hay partidos con cuotas reales | «no hay ningún partido con cuotas reales por delante» | arreglar las cuotas |
| Los hay y se descartan todos | «se evaluaron N partidos y ninguno pasó la política de riesgo» | **nada: es el modelo decidiendo no apostar** |
| Los hay y apuesta | la tabla de apuestas | seguirlo |

El tercer caso —el que más despista— es el experimento funcionando perfectamente. Sin
dejar escrito el recuento de rechazos y su motivo, se lee como una avería. Por eso cada
pasada guarda cuántos partidos miró, cuántos apostó y **por qué descartó el resto**:

```
Última revisión: 1 partido(s) con cuotas reales, 0 apostado(s).
  · 1 descartado(s) por ventaja insuficiente
```

**Es hacia delante, no una simulación del pasado.** Se podría recorrer el histórico y
calcular qué habría pasado, pero no hay cuotas históricas de tenis guardadas y el log
resuelto con precio son 15 partidos de la NFL — una muestra con la que cualquier ROI es
ruido. Hacia delante es más lento y es lo único defendible: la apuesta se registra
**antes** del partido, con el precio de ese momento, y se liquida con el resultado real.

```bash
npm run paper     # el banco desde la terminal: liquida, apuesta y resume
```

**Qué deportes apuestan, y por qué no todos.** La política de sizing falla cerrado: sin
una calibración medida, no dimensiona. Eso deja tres situaciones distintas:

| Deporte | Calibración medida | ¿Apuesta? |
| --- | --- | --- |
| **Tenis** | ECE 0,64 pp · 22.062 predicciones | **sí**, tamaño a la mitad |
| **Fútbol** | ECE 0,86 pp · 71.319 predicciones | **sí**, tamaño a la mitad |
| **Baloncesto** | ECE 0,12 pp · 85.562 predicciones | **sí**, tamaño a la mitad |
| **Béisbol** | ECE 1,12 pp · 14.337 predicciones | **sí**, tamaño a la mitad |
| **NFL** | ECE 1,82 pp, y medido **peor que la línea de cierre** | **nunca** |

Los cinco backtests escriben ahora su propia calibración donde la lee la política
(`npm run backtest`, `:bb`, `:bsb`, `:fb`). Se escribe desde el backtest y no desde un
script aparte a propósito: duplicar el cálculo habría creado dos ECE del mismo deporte
que se separan en cuanto uno de los dos se toque.

El «tamaño a la mitad» de los cuatro que apuestan no es prudencia decorativa. Un modelo
puede estar impecablemente calibrado consigo mismo y ser peor que el precio — es
exactamente lo que le pasa al de la NFL, bien calibrado y perdiendo dinero. Sin cuotas
históricas con las que comprobarlo, esa posibilidad sigue abierta y el tamaño lo refleja.

El fútbol y el baloncesto son donde este banco tiene más que hacer: trece ligas el uno y
siete el otro, y la calibración medida sobre 71.319 y 85.562 predicciones. Y ahí el empate
compite en igualdad con los dos equipos en vez de ganar por tener siempre la cuota más
alta — lo elige `bestSelection`, que aplica el mínimo de ventaja, y no un «la de más
ventaja» a secas.

El empate, además, **pierde**: es uno de los tres resultados, no una anulación. Tratarlo
como void —lo correcto en la NFL, donde el moneyline se devuelve— le regalaría al modelo
uno de cada cuatro partidos de fútbol sin riesgo.

**Dos deportes no apuestan, y por buenas razones.** La política de sizing falla cerrado:
sin una calibración medida, no dimensiona. La NFL está medida como **peor que la línea de
cierre**, así que su multiplicador es cero y no apostará nunca — apostar contra un precio
mejor que tu propia estimación es perder por definición. El tenis sí apuesta, pero con el
tamaño limitado a la mitad porque no hay cuotas históricas con las que comprobar si le
gana al mercado; ese `null` no es un «probablemente sí».

De paso, `npm run backtest` ahora **escribe** la calibración del tenis donde la lee la
política (ECE 0,64 pp sobre 22.062 predicciones). Antes no existía esa entrada y el banco
no podía apostar en el deporte principal de la app — no por prudencia, por falta de dato.

### Preguntar a los datos, sin que nada se los invente

En la pestaña de tenis hay un recuadro donde se escribe una pregunta y sale una
respuesta. **No hay ningún modelo de lenguaje detrás, y esa es la característica.**

Un chatbot que contesta «Alcaraz tiene 2180 de Elo» es un generador de frases
plausibles, y un número plausible es justo lo que no sirve para comprobar nada: suena
igual esté bien o mal, y distinguirlo obliga a ir a mirarlo a mano — que es el trabajo
que se quería ahorrar. Para *comprobar datos*, un modelo de lenguaje es la herramienta
equivocada.

El reparto que sí funciona:

1. La pregunta se clasifica en una de seis consultas. Es una tarea de clasificación con
   seis salidas, y para eso bastan unas expresiones regulares: sin clave, sin coste, sin
   red, y **determinista** — la misma pregunta da siempre la misma consulta.
2. La consulta la ejecuta SQLite contra la base, y el número que sale es el mismo que
   enseña la pestaña.
3. **Cada respuesta dice de dónde viene**, para poder repetirla a mano.

| Pregunta | Qué contesta |
| --- | --- |
| `Alcaraz` | Elo general y por superficie, récord, ranking oficial |
| `cara a cara Alcaraz contra Sinner` | el historial real, partido a partido |
| `quién gana Sinner contra Djokovic en tierra` | la predicción del modelo, con su fiabilidad |
| `top 10 ATP` | la clasificación por Elo |
| `estado de los datos` | qué hay guardado y por qué faltan cuotas |
| `qué precisión tiene el modelo` | las cifras del backtest, citadas como tales |

Ninguna herramienta acepta SQL de fuera: son funciones con argumentos tipados y las
consultas escritas en el código. A un asistente al que se le puede dictar SQL se le puede
dictar `DROP TABLE`.

### El agente de varios pasos (sin clave, sin coste)

Un agente, en el sentido útil, es algo que **decide una secuencia**: mira la pregunta,
elige una consulta, y con lo que sale decide si hace falta otra. Eso es lo que hace
`compara a Alcaraz y Sinner`:

```
vía: agente | pasos: jugador → jugador → caraACara → prediccion
plan: comparación: ficha de cada uno, cara a cara y predicción — cuatro consultas
```

Encadenar aporta algo real: «¿quién es mejor?» no tiene *una* respuesta en la base, tiene
cuatro, y el enrutador de un paso tenía que elegir una y tirar las otras tres. Con las
cuatro juntas sale lo interesante:

| | |
| --- | --- |
| Ranking oficial | Alcaraz 1º · Sinner 2º |
| Elo general | Sinner 2347 · Alcaraz 2286 |
| Cara a cara | **Alcaraz 10–6** |
| El modelo, en dura | **Sinner 60,6 %** |

Los cuatro números discrepan y cada uno tiene su motivo — en pista dura el Elo de Sinner
es 2335 contra 2192. Un asistente que promediara eso en silencio y soltara un número
sería menos útil, no más.

Y sigue sin redactar nada: el resumen se **compone** de los textos que ya devolvieron las
herramientas. Si aquí se escribiera «X está claramente por delante», esa frase sería una
opinión sin medir colada entre datos medidos.

### El enrutador con modelo de lenguaje (opcional, `ANTHROPIC_API_KEY`)

Con una clave en el `.env`, un modelo elige **qué herramienta** y **con qué argumentos**.
Nada más: el texto lo sigue componiendo `tools.ts` desde SQLite. Así el modelo no puede
equivocarse en una cifra — si se equivoca, contesta a otra pregunta, y eso se nota.

Lo que aporta se ve mejor con una pregunta mal escrita:

| | herramienta y argumentos |
| --- | --- |
| con modelo | `prediccion` · `["Alcaraz", "Sinner", "tierra"]` |
| sin modelo | `prediccion` · `["oye y si juegan alcarazz", "siner en polvo de ladrillo quien gana", ""]` |

Lo que **no** aporta: ningún dato, y ninguna respuesta mejor a una pregunta que el
enrutador ya entendía. `top 10 ATP` da lo mismo con clave que sin ella. Por eso está
apagado por defecto: cuesta dinero por pregunta y casi todo el valor de esta pantalla no
depende de él.

**Falla hacia el lado seguro, comprobado caso por caso.** Sin clave, con HTTP 401, con la
red caída, con una respuesta que no se entiende, o con un nombre de herramienta que no
existe → se usa el enrutador determinista y la pantalla dice cuál de los dos contestó.
Nunca sale un error por culpa del modelo, porque la app funciona perfectamente sin él.

Y lo que devuelve el modelo se **valida**: el nombre contra la lista y cada argumento por
tipo. No es desconfianza decorativa — eso es texto de un servicio externo que va directo
a elegir qué consulta se ejecuta.

### «Hoy», en los siete deportes a la vez

La app se organiza **por deporte** y eso es correcto: los modelos son distintos, los
mercados son distintos, y mezclarlos en una lista haría ilegibles los cinco. Pero hay una
pregunta que no respeta esa división y es la primera que se hace cualquiera al abrir la
app: **¿qué hay hoy?** Contestarla costaba cinco clics y acordarse de lo que decía cada
pestaña.

Ahora sale arriba del todo, encima del contenido y fuera de las pestañas:

```
Hoy · 13 partidos en los siete deportes · 13 por jugar

  17:00  🏈  Carolina Panthers @ Atlanta Falcons      Atlanta Falcons 64%
  17:00  🏈  New Orleans Saints @ Baltimore Ravens    Baltimore Ravens 70%
  17:00  🏈  Minnesota Vikings @ Chicago Bears        Chicago Bears 55%
```

Se pliega, y plegado **se recuerda entre visitas**: quien ya sabe lo que hay hoy no
quiere volver a verlo cada vez que cambia de deporte, y una cabecera que no se puede
quitar acaba siendo un peaje.

### Y el cierre del círculo: «¿Acertó?»

El mismo panel tiene un segundo interruptor. «Hoy» dice lo que el modelo cree; sin la otra
mitad eso es una promesa sin cumplir, y una app de predicciones que solo enseña
predicciones es indistinguible de una que las inventa.

```
Cómo le fue al modelo · 9 de 13 en los últimos 7 días · 69 % · esperaba 63 %

  14 sept  🏈  Dallas Cowboys @ New York Giants     dijo New York Giants 53%   ganó New York Giants ✓
  13 sept  🏈  Arizona Cardinals @ LA Chargers      dijo LA Chargers 75%       ganó Arizona Cardinals ✗
  13 sept  🏈  Miami Dolphins @ Las Vegas Raiders   dijo Miami Dolphins 51%    ganó Las Vegas Raiders ✗
```

El panel de historial de cada pestaña ya daba el **agregado** (acierta el 65 %), que es el
número honesto y el que hay que mirar para juzgar. Esto es otra cosa: **partido a partido,
comprobable con tu propia memoria**. Quien vio el partido de ayer puede verificar esa fila
sin fiarse de nadie, y eso es lo que convierte un porcentaje en algo en lo que apoyarse.
El pie lo dice explícitamente, para que trece partidos no se confundan con la medida real.

Y dice **qué cabía esperar**. «53 %» a secas no dice si el modelo va mal: con las
probabilidades que dio, el número de aciertos esperado es su suma, y su dispersión la suma
de p·(1−p). En una semana de NFL eso da algo como «esperaba 10 de 15; entre 6 y 13 es lo
normal por azar, así que 8 está dentro». Es la diferencia entre «el modelo va mal» y «ha
sido una semana corta», y con quince partidos casi siempre es lo segundo.

**Funciona sin cuotas**, que es lo que lo hace útil incluso con el proveedor caído: para
saber si el modelo acertó no hace falta ningún precio, solo el resultado.

Se enseña **quién ganó** junto al ✓/✗. Solo la marca, sin el resultado, lo volvería
incomprobable — que es exactamente lo contrario de para lo que existe la vista.

Tres decisiones que hacen que el número signifique algo:

- **Las probabilidades salen del log de predicciones, no se recalculan.** El log guarda la
  que *se mostró*, con su fecha. (Esto **no era cierto** en NFL y fútbol hasta ahora: el log
  guardaba la cruda del modelo, antes del post-proceso, y el panel puntuaba esa. En la NFL la
  que se enseña es casi el precio de mercado, así que el panel juzgaba una predicción que
  nadie había visto, y además la peor: desde 2020 el favorito crudo acierta el 65,3 % y el
  enseñado el 66,6 %, sobre 1.718 partidos; discrepan en uno de cada siete. Ahora el log
  guarda las dos —`prob_*` la cruda, que el historial necesita para medir el modelo contra
  el mercado, y `shown_*` la enseñada—, y las filas antiguas se rellenan solas: exactas en
  fútbol, a unas décimas en la NFL.) Recalculando aquí, esta vista podría decir un número y la
  pestaña del deporte otro para el mismo partido, y no habría forma de saber cuál se usó.
  Un partido que aún no ha pasado por el log sale como **«sin predicción»** en vez de con
  una inventada, y el pie dice cuántos van así.
- **La ventana es la misma que usa cada pestaña** (`freshSince`). Con un corte propio,
  esta vista podría enseñar un partido que la pestaña ya escondió, o al revés.
- **Un partido ya empezado no se esconde** —sigue siendo lo de hoy— pero se atenúa. Verlo
  al mismo nivel que uno por jugar invita a apostarlo.

### ¿Están las cuotas al día? Y bajar el gasto: `npm run ahorro`

```bash
npm run ahorro                    # qué cuesta la cadencia actual, y qué costaría cada otra
npm run ahorro -- --minutos=720   # una cada 12 horas
npm run ahorro -- --auto          # que la calcule la app
```

La variable `AUTO_REFRESH_MINUTES` ya existía y estaba documentada, pero ponerla exigía
saber tres cosas que no estaban a la vista: qué cadencia tienes, cuánto cuesta un ciclo en
tu plan, y por tanto qué número escribir. Sin eso, elegir es adivinar — y adivinar por lo
bajo deja los precios viejos, adivinar por lo alto quema el plan. Así que el comando
**primero dice lo que cuesta lo que ya tienes**, con datos medidos: lo que gastó el último
ciclo de verdad y el tamaño del plan que la API declaró en sus cabeceras.

```
  plan de The Odds API   25.000 peticiones al mes
  coste de un ciclo      8 peticiones (medido en el último)

    cada 1 h         5760 peticiones/mes  cabe en el plan
    cada 6 h          960 peticiones/mes  cabe en el plan
    cada 12 h         480 peticiones/mes  cabe en el plan
```

`--auto` **quita** la línea en vez de ponerla a cero: un 0 *desactiva* el refresco, que es
otra cosa muy distinta de «que lo calcule la app». Confundirlos dejaría las cuotas
congeladas creyendo haber activado el modo automático.

Y bajar la cadencia **no afecta** a los refrescos que pides tú: `npm run odds` y el botón
siguen funcionando igual y nunca se frenan.

### Una lista congelada tiene que verse congelada

Cuando el refresco se para —plan agotado, freno de ritmo, la app cerrada— la tabla sigue
ahí con las mismas cuotas y **el mismo aspecto de estar al día**. Nada en la pantalla
distinguía un precio de hace diez minutos de uno de hace dos días, y esa es justo la
diferencia que decide si una cuota sirve para algo.

Ahora la tabla de partidos lo dice: `precios hace 20 min`, y pasadas **seis horas** en
ámbar con un `— puede que ya no valgan`. Seis y no una: con el plan gratuito un ciclo cabe
cada pocos días, así que avisar a la hora teñiría de alarma el funcionamiento normal, y un
aviso permanente se deja de leer.

**Las probabilidades son otra cosa y sí están siempre al día:** se calculan en cada
petición a partir de los ratings actuales, no se guardan. Lo que puede envejecer es el
histórico del que salen esos ratings, y para eso ya está el aviso de datos viejos de la
cabecera.

### ¿Cuántos tokens gasta esto? `npm run tokens`

Solo aplica si has activado el enrutador con modelo; sin `ANTHROPIC_API_KEY` la app no
gasta ni un token y el comando lo dice.

```bash
npm run tokens              # llamadas, tokens de entrada y de salida, media por pregunta
npm run tokens -- --reiniciar   # contador a cero, por ejemplo al empezar un mes
```

Es la misma lección que con The Odds API, escrita en `oddsQuota.ts`: *«el plan gratuito
se agotó porque nada lo mencionaba hasta que ya no quedaba»*. El enrutador falla igual —
se paga por pregunta, nadie ve cuánto, y la factura llega sin poder repartirla entre lo
que la produjo. Y el dato viene **gratis en cada respuesta** de la API, igual que la cuota
de The Odds API viene en sus cabeceras. Se estaba tirando.

**Se cuentan también las llamadas que se descartan.** Si el modelo contesta algo que no
sirve y la app cae al enrutador determinista, esos tokens se han pagado igual. Contar solo
las útiles daría un total por debajo del real, que es la peor dirección para equivocarse
en una factura.

**Tokens sí, dinero solo si lo pones tú.** Los tokens son una medida: los cuenta el
proveedor. El precio no lo es — depende del modelo, del plan y de la fecha. Una cifra a
ojo aquí daría un coste con aspecto de medido que puede estar al doble, así que el coste
solo aparece si escribes `LLM_PRECIO_ENTRADA` y `LLM_PRECIO_SALIDA` en el `.env`, y
entonces la salida dice que sale de ahí.

Y cuenta **solo lo que gasta esta aplicación**. Lo que gastes hablando con un modelo por
tu cuenta no aparece y no puede aparecer.

### «No quiero partidos inventados»: `npm run demo -- --off`

```bash
npm run demo              # ¿están encendidos o apagados?
npm run demo -- --off     # que la app no invente nada
npm run demo -- --on      # volver a tenerlos
```

Sin cuotas reales, la app genera partidos plausibles a partir de su propio Elo con un
precio que no es de ninguna casa. Para una instalación recién hecha, sin clave y sin
internet, eso evita que la app parezca rota. **Con una clave que funciona, estorba**: un
partido inventado ocupa el sitio de uno real, se mezcla con los reales en la misma lista
y lleva un precio que no es de nadie.

Apagado, las pestañas sin cuotas reales se quedan **vacías y diciendo por qué**, con la
causa concreta y las ligas que se consultaron. Una pantalla vacía con su motivo es una
respuesta; una imitación plausible de la realidad no lo es.

Lo que NO se va al apagarlo: la NFL conserva sus partidos, porque nunca se inventó
ninguno — su calendario viene de nflverse y es real, con línea de cierre o sin ella. Y el
modelo, los Elo, el historial y la clasificación siguen exactamente igual en los cinco
deportes: lo único que desaparece son las filas que no correspondían a ningún partido.

El comando edita `DEMO_FIXTURES` en el `.env` **leyendo el fichero y reescribiéndolo
entero**, nunca sobrescribiéndolo a ciegas: tu clave no se mueve de donde está. (Un
`echo … > .env` hecho a mano ya se llevó por delante una clave bien puesta en este
proyecto; de ahí el comando.)

### Que se actualice solo: `npm run auto`

```bash
npm run auto              # una vez, y ya no hay que acordarse de nada
npm run auto -- --estado  # ¿funciona? ¿qué hizo la última vez?
npm run auto -- --hora=7  # cambiar la hora (por defecto, las 9:00)
npm run auto -- --quitar  # desinstalarlo
```

Conviene saber qué se actualizaba solo ya y qué no:

- **Las cuotas ya se refrescaban solas** mientras el servidor está en marcha, a un ritmo
  que se ajusta al tamaño de tu plan. Esa parte nunca hizo falta tocarla.
- **El histórico no**, y es el que envejece peor: una base de hace tres semanas abre
  igual, predice igual y no se queja. Enseña resultados de hace tres semanas con la misma
  seguridad que los de ayer, y los Elo que salen de ahí son los de hace tres semanas.

`npm run auto` pone eso en el calendario del sistema. Descarga la base ya construida
—9 MB, unos segundos— y, si nadie la ha publicado todavía, la reconstruye desde las
fuentes. **Conserva tus apuestas y tu histórico de aciertos**, y deja copia de la
anterior. No gasta ni una petición de The Odds API.

En un Mac usa **launchd y no cron**, y no es una preferencia: si el portátil está dormido
a la hora de la cita, cron se salta esa cita y launchd la lanza al despertar. Para un
portátil que se cierra por la noche, es la diferencia entre actualizarse y no
actualizarse nunca. En Linux el comando no instala nada: imprime la línea de cron
equivalente, con ese aviso.

---

## Requisitos

- **Node.js ≥ 22.13** (usa el módulo integrado `node:sqlite`, que desde esa versión no necesita el flag experimental; sin dependencias nativas).

## Instalación

```bash
git clone <este-repo>
cd <repo>
npm install
cp .env.example .env    # opcional: para odds reales, ver abajo
```

## Puesta en marcha rápida (con datos de demostración, sin internet)

```bash
npm run seed     # carga un dataset de muestra en data/history.db
npm run dev      # levanta API (:7374) + frontend (:7373)
```

Abre **http://localhost:7373**. Elige ATP/WTA y un torneo (Wimbledon, US Open…), verás los
próximos partidos con la predicción del modelo y las odds lado a lado.

> El seed usa **datos sintéticos** (nombres reales, partidos simulados) para que la app
> funcione end-to-end sin conexión. El badge "datos demo" lo indica. Reemplázalo con datos
> reales usando `npm run update-data`.

---

## El diagnóstico de punta a punta: `npm run doctor`

Recorre el camino entero de una cuota, en el orden en que viaja —
`.env → The Odds API → competiciones → base de datos → frescura → backend → pantalla` — y
termina con un **RESULTADO** y una lista numerada de **QUÉ HACER**, cada punto con su solución
copiable.

```
npm run doctor              # gratis: no gasta ni un crédito
npm run doctor -- --probar  # 1 crédito por deporte en juego: eventos, mercados y casas REALES
npm run doctor -- --sin-red # sin hablar con el proveedor
npm run doctor -- --fuentes # además, una petición ligera a cada fuente de datos: ¿contesta desde aquí?
```

| Sección | Qué comprueba |
| --- | --- |
| CONFIGURACIÓN | `.env` en su sitio, clave detectada (`ODDS_API_KEY` o `THE_ODDS_API_KEY`), formato de la línea, **la terminal pisando al `.env`**, regiones válidas, zona horaria |
| THE ODDS API | clave válida, API responde, créditos restantes y usados, plan, gasto estimado por día, freno de ritmo |
| DEPORTES | por deporte, lo que contestó cada competición en la última descarga: eventos, **con cuotas**, casas, y el error exacto si falló |
| BASE DE DATOS | próximos eventos, con cuotas reales, de demostración y sin cuotas |
| ACTUALIZACIÓN | cuándo se actualizó y si las cuotas reales tienen más de 6 h |
| CONFIANZA | ciclo pre-partido, predicciones congeladas, decisiones de las últimas 24 h y alertas internas |
| DATOS Y COPIAS | los dos ficheros, migraciones (`schema_version`) fallidas o al día, copia del libro mayor y su cadencia, copia fuera (S3), retención de snapshots, ingestas recientes y las que se quedaron a medias |
| OPERACIÓN | trabajos programados (los que fallaron en su última pasada o se quedaron «en marcha»), canales de notificación configurados y envíos fallidos en 24 h, interruptores (encendidos, inactivos por falta de variable, anulaciones huérfanas), **frescura de los resultados por deporte** (aviso si en plena temporada llevan más de 21 días sin uno nuevo) y, con `--fuentes`, qué fuentes no contestan |
| ANALÍTICA E INTERFAZ | deriva de los modelos, diagramas de fiabilidad, simulación de temporada, calendario pendiente, anulaciones y seguimiento |
| PRODUCTO | laboratorio de estrategias, «¿qué habría pasado?», bandeja, informes, comparador de líneas, archivo y las ampliaciones de la Fase 8 (asistente por Telegram, tenis punto a punto, props de la NBA; la NHL y la UFC ya van con los demás deportes) |
| SEGURIDAD | contraseña, cabeceras, CORS, errores de servidor, `.env` fuera de git, escáner de secretos y hook de pre-commit |
| SERVIDOR Y PANTALLA | backend vivo, cuántos partidos ve la pantalla y cuántos con cuota real |

Código de salida 0 si no hay errores (puede haber advertencias), 1 si los hay.

### Por qué «no hay partidos con precio» podía ser mentira

Había cinco copias de la petición de cuotas, una por deporte, y cada una trataba los errores a
su manera. Ahora hay **una** (`server/src/oddsApi.ts`) y nunca convierte un error en una lista
vacía. Lo que se arregló:

- **Tenis y baloncesto** convertían un 404 o un 422 en «no hay partidos». Un 422 significa
  *parámetros inválidos*: era un error disfrazado de calendario vacío.
- **El tenis** perdía los errores de cada torneo (solo iban a la consola) y acababa diciendo
  `sin_ligas`, «no sé traducir esos circuitos», cuando lo que había eran 401.
- **Baloncesto y fútbol** reponían «sin eventos» al empezar cada liga: si una liga fallaba con
  401 y la siguiente venía vacía, el 401 desaparecía y quedaba «no hay partidos con precio».
- **El béisbol** abandonaba el resto de ligas en cuanto una fallaba.
- **La NFL** acababa en «sin eventos» pasara lo que pasara.
- El listado llamaba «cupo agotado» al **429**, que es *demasiadas peticiones seguidas*; el cupo
  agotado llega como 401 `OUT_OF_USAGE_CREDITS`.
- Un evento **sin ninguna casa en tus regiones** contaba como «cuotas reales».

Ahora cada descarga guarda, por competición, el código HTTP, los eventos, cuántos con precio y
cuántas casas, y el doctor lo enseña. `soccer_epl=0 eventos` y `soccer_epl: HTTP 401
sin_creditos` ya no se leen igual. Todo está fijado por tests (`npm test`); los de la ingesta
de fútbol se comprobaron contra el código anterior, y fallan con él.

## Abrirla en el teléfono

### `npm run phone` daba el puerto equivocado cuando más falta hacía

`npm run dev` busca un puerto libre si el 7373 está ocupado — es lo que permite tener la
app corriendo junto a otro proyecto. Pero `npm run phone` se lanza en **otra terminal**, no
hereda el entorno de `dev`, y leía `WEB_PORT` de un sitio donde no está: caía a 7373
siempre.

O sea que justo en el caso para el que existe la búsqueda de puerto libre, la app quedaba
en 7376 y esto mandaba a escribir **7373** en el teléfono. Una dirección que no carga,
acompañada de un «la app no está corriendo» que era **falso**. Reproducido ocupando los dos
puertos a mano:

```
dev eligió: 7376 / 7377
phone decía: http://192.168.x.x:7373   ❌ la app está corriendo
phone dice:  http://192.168.x.x:7377   ✅ la app está corriendo
```

Ahora `dev` escribe los puertos que acabó eligiendo en `data/.dev-ports.json` y `phone` los
lee — pero **los comprueba antes de fiarse**, porque un puerto guardado no es un puerto
vivo: si el servidor murió, el fichero sigue ahí mintiendo. Con nada corriendo enseña el
puerto por defecto, no el de la sesión anterior, que ya no significa nada.


Con la app corriendo (`npm run dev`):

```bash
npm run phone
```

Imprime la dirección que hay que escribir en el navegador del móvil —algo como
`http://192.168.1.42:7373`— y comprueba que la app y la API estén levantadas. El teléfono tiene que
estar en **la misma red Wi-Fi**; no se publica nada en internet.

Una vez abierta, en el menú del navegador: **«Añadir a pantalla de inicio»**. Queda con su icono, a
pantalla completa y sin barra de navegador, porque la app trae `manifest.webmanifest`, iconos de
192/512 px y el de 180 px que pide iOS.

**Si carga en el ordenador pero no en el teléfono**, casi siempre es el cortafuegos del sistema
bloqueando el puerto 7373 (macOS: Ajustes → Red → Firewall; Windows: permitir Node.js en redes
privadas).

Un detalle que evita un problema: el teléfono **no necesita alcanzar la API**. Llama a `/api/…` sobre
la misma dirección de la web, y el ordenador que sirve la página hace de proxy hacia el backend.

Para que vaya más rápido en el móvil, sirve el build en vez del servidor de desarrollo:

```bash
npm run build
npm run preview --workspace web    # queda en el puerto 7375
```

## Abrirla sin escribir nada: `scripts/abrir.command`

En un Mac, **doble clic** en `scripts/abrir.command` y la app se abre. No hace falta la
Terminal ni acordarse de la carpeta: el fichero se sitúa solo desde su propia ruta, así
que funciona esté donde esté el proyecto.

Arrástralo al Dock o haz un alias en el Escritorio y queda a un clic.

Lo que hace que este `.command` funcione y la mayoría no: **el Finder lo lanza con un
shell que no ha leído tu `~/.zshrc`**, así que un Node instalado con nvm —lo más habitual
en un Mac— sencillamente no está en el PATH, y el doble clic abre una ventana que dice
«command not found: npm» y se cierra. Este carga nvm si está, prueba las rutas de Homebrew
(Apple Silicon e Intel) y de Volta, y si aun así no encuentra Node **lo dice, con el
comando de la Terminal escrito**, en vez de cerrarse. La ventana tampoco se cierra sola al
terminar: si algo falló, el motivo está justo encima.

## Ponerla en línea (Fly.io)

Para abrirla desde el móvil en cualquier sitio, no solo en tu wifi. Cuatro comandos una
vez, y `npm run deploy` a partir de entonces.

```bash
brew install flyctl
fly auth login
fly launch --no-deploy          # escribe tu nombre de app en fly.toml
fly volumes create datos --size 3
fly secrets set APP_PASSWORD="una-frase-larga-y-tuya"   # secret-scan:ignore (es un ejemplo)
fly secrets set ODDS_API_KEY="tu-clave"   # opcional: sin ella, cuotas de demostración
npm run deploy
```

`npm run deploy` comprueba en dos segundos todo lo que `fly deploy` descubriría al final
de una construcción de varios minutos: que estás autenticado, que la app y el volumen
existen, que la contraseña está puesta y que hay base de datos que llevar.

### Por qué lleva contraseña, y por qué no arranca sin ella

En el portátil, «sin autenticación» significa «sin autenticación en localhost». En una URL
pública significa otra cosa: la tabla `bets` guarda importe, beneficio y notas de cada
apuesta, y `/api/refresh` dispara una llamada a The Odds API — cualquiera que lo pulse
gasta tu cuota, y el plan gratuito son 500 al mes.

Con `NODE_ENV=production` y sin `APP_PASSWORD`, **el servidor se niega a arrancar**. Un
aviso en el log se lee una vez, en un despliegue que salió bien, y la app queda abierta
durante meses funcionando perfectamente — que es justo el fallo que no da síntomas. Un
despliegue que falla se arregla; uno que queda abierto no se entera nadie. En local no
cambia nada.

La única ruta sin contraseña es `/healthz`, porque Fly la usa para saber si la máquina
vive: si respondiera 401 la daría por muerta y la reiniciaría en bucle. No toca la base ni
devuelve nada más que `{ ok: true }`.

### Tres cosas que se decidieron por un motivo concreto

**La base vive en un disco aparte, no en la imagen.** Una imagen de contenedor se
reemplaza entera en cada despliegue. Con la base dentro, cada `fly deploy` borraría el
registro de apuestas y todo lo descargado — sin error y sin aviso, porque la app
arrancaría perfectamente, vacía. Por eso `DATA_DIR` es configurable y el volumen se monta
en `/data`. El arranque copia ahí la base de la imagen **solo si el disco está vacío**;
copiarla siempre sería una línea más corta y machacaría tus datos en cada despliegue.

**El servidor sirve el frontend.** En desarrollo hay dos servidores —Vite sirve la web y
hace de proxy hacia Fastify—; en producción solo hay uno. Sin esto, el despliegue
respondería a `/api/…` y daría 404 en la portada: una app «desplegada con éxito» que no se
puede abrir. Pasó literalmente al probarlo, por otra causa: la ruta índice de la API
también estaba en `/` y ganaba al `index.html`, así que abrir la URL devolvía un JSON
describiendo la API. Ahora esa ruta solo se registra cuando no hay app que servir.

**Supabase no servía para esto**, aunque sea lo primero que se piensa. Supabase es Postgres
más auth y almacenamiento: no ejecuta un proceso Node persistente, y esta app *es* un
proceso —cadenas de Markov, ajustes de Elo, el modelo de puntos—. Y usarlo solo para los
datos costaría reescribir **355 llamadas `db.prepare(...)` repartidas por 80 ficheros**,
para acabar necesitando igualmente dónde correr el servidor.

## Un solo comando: `npm run go`

```bash
npm run go
```

Hace los seis pasos y arranca la app:

1. **Node** — comprueba la versión y para si no llega a 22.5, diciendo cómo actualizarla.
   Va primero porque es el único fallo cuyo síntoma no señala a la causa: `node:sqlite` no
   existe antes de 22.5 y el error parece un problema de dependencias.

   Y el comando **no lleva banderas de Node**, por un motivo que costó encontrar: la
   primera versión era `node --experimental-sqlite … scripts/go.mjs`, y **Node 20 rechaza
   esa bandera antes de leer el fichero** (`node: bad option`, código 9). Es decir que
   quien tuviera Node viejo —exactamente a quien va dirigido este mensaje— veía un error
   críptico sobre una bandera en lugar del aviso. El control estaba escrito y era
   inalcanzable. Ahora no hay banderas, el import de `node:sqlite` es perezoso y el aviso
   de «experimental» se silencia desde dentro. Comprobado contra un Node 20.20.2 real.
2. **Rama** — se pone en `claude/tennis-prediction-app-jlhgxh`. La rama por defecto del
   repositorio es otro proyecto, así que un clon nuevo **no tiene esta app**. Si tienes
   cambios sin guardar no cambia de rama: descartar tu trabajo para arrancarte la app no
   es un intercambio que un script de arranque tenga derecho a hacer.
3. **Pull** — `--ff-only`, y solo si estás en la rama del proyecto. Antes de tirar
   devuelve `package-lock.json` y `data/raw/.gitkeep` a su versión del repo si están
   tocados: son ficheros generados, y bastaba con que tu `npm` fuese de otra versión para
   que el lock cambiara y **todos** los pull se abortaran con «your local changes would be
   overwritten by merge», dejando la app congelada. Ningún otro fichero se toca. Los fallos de red se
   reintentan (2s, 4s, 8s, 16s); una divergencia no, porque reintentar no la arregla.
4. **Dependencias** — `npm install` solo si el lock ha cambiado.
5. **Base de datos** — si no hay, intenta la descarga rápida y, si la release no está
   publicada todavía, la construye desde las fuentes. Si ya hay, dice **hasta cuándo
   llegan los resultados**: una base de hace tres semanas abre igual, predice igual y no se
   queja, así que enseña partidos de hace tres semanas con la misma seguridad que los de
   ayer. La fecha se saca del último partido jugado y no del `mtime` del fichero, porque
   actualizar y no recibir nada nuevo toca el fichero sin mover los datos — y entonces el
   `mtime` diría «hoy» de una base de hace un mes. Pasados 5 días te da el comando.
6. **Arranca** — y avisa si falta `ODDS_API_KEY` (la app funciona igual, con cuotas de
   demostración).

**No gasta cuota de The Odds API.** Ni una petición: si hay que construir la base se hace
con `--skip-odds`. Refrescar precios cuesta (500 al mes en el plan gratuito) y no puede
esconderse dentro de «arráncame la app».

La regla que gobierna los seis pasos: **un paso que falla no puede parecer que fue bien, y
uno que falla sin ser grave no puede impedir que la app arranque.** Son fatales Node viejo,
`npm install` roto y quedarse sin base; son avisos la falta de red, los cambios locales y
la falta de clave. Sin la primera mitad, «hazlo todo tú» se convierte en un script que se
come los errores y deja una app rota sin decir dónde mirar. Sin la segunda, un avión sin
wifi te deja sin app, cuando la base y el modelo son locales.

Un bug que salió al probarlo, y que vale contar: la primera versión hacía
`git pull origin <rama-del-proyecto>` sin comprobar en qué rama estabas. Cuando no podía
cambiarse de rama —por tener cambios sin guardar— traía los commits del proyecto **encima
de la rama en la que estuvieras**, mezclando dos historias sin mencionarlo. Se vio al
probar ese caso concreto, no leyendo el código.

## Scripts

| Comando | Qué hace |
|---------|----------|
| `npm run deploy` | Sube la app a Fly.io, comprobando antes todo lo que fallaría al final del despliegue |
| `npm run go` | **Todo en uno**: rama, pull, dependencias, base de datos y arranque. El único que hace falta saber |
| `npm run auto` | Instala la actualización diaria de los datos (launchd en macOS) y deja de hacer falta acordarse |
| `npm run demo` | Enciende o apaga los partidos inventados. `-- --off` deja solo lo real |
| `npm run paper` | El banco de papel del modelo: liquida lo resuelto, apuesta lo que apruebe la política y resume |
| `npm run tokens` | Tokens que ha gastado el enrutador con modelo del asistente, y su coste si pones los precios |
| `npm run ahorro` | Qué cuesta el refresco automático de cuotas y bajar la cadencia sin adivinar |
| `npm run dev` | Levanta backend + frontend a la vez (ambos deportes) |
| `npm run seed` | Tenis: carga el dataset de demostración |
| `npm run fetch-data` | **Descarga la historia ya construida** (`history.db`, 9 MB) en vez de reconstruirla. `-- --force` reemplaza la que haya; tu `ledger.db` (apuestas, predicciones registradas) no se toca |
| `npm run db:migrate` | Parte el `tennis.db` antiguo en `history.db` + `ledger.db` (sin perder nada), aplica las migraciones pendientes y enseña el estado. `-- --reintentar` tras arreglar una fallida |
| `npm run backup` | **Copia del libro mayor** (`ledger.db`) ahora: local (últimas 14) y, con `BACKUP_S3_*`, también a S3/R2/B2. El servidor la hace solo cada `BACKUP_HOURS` h |
| `npm run restore -- <fichero>` | Restaura una copia como libro mayor (con el servidor parado; la actual se aparta). Sin argumento, lista las copias |
| `npm run odds:retention -- --dias N` | Enseña qué snapshots de cuotas de más de N días sobrarían (se conservan apertura, T-24h, T-6h, T-1h y cierre por casa). `--confirmar` los exporta a `data/archive/` y los quita. Nunca corre sola |
| `npm run db:explain` | `EXPLAIN QUERY PLAN` de las consultas calientes: ninguna puede recorrer su tabla entera |
| `npm run fetch-flags` | Baja al repo los SVG de las banderas (211, ~1,4 MB). **Solo hace falta una vez**: ya están commiteadas. Se vuelve a correr al añadir un país a `config/countries.json` |
| `npm run update-all` | **Los seis deportes de una tirada.** `-- --skip-odds` no gasta cuota; `-- --only fb,bb` limita a algunos. Un deporte que falle no para a los demás y el resumen dice cuál fue |
| `npm run update-data` | Tenis: refresca histórico real + odds |
| `npm run backtest` | Tenis: mide la exactitud del modelo |
| `npm run update-data:bb` | **Baloncesto**: equipos, resultados, partidos próximos y cuotas |
| `npm run backtest:bb` | **Baloncesto**: mide el modelo (incluye comparación con FiveThirtyEight) |
| `npm run update-data:fb` | **Fútbol**: equipos, resultados, partidos próximos, cuotas y plantillas |
| `npm run update-squads:fb` | **Fútbol**: solo las plantillas y el parte de lesionados (cambia a diario) |
| `npm run update-data:bsb` | **Béisbol**: equipos, resultados, lanzadores, partidos próximos y cuotas |
| `npm run backtest:bsb` | **Béisbol**: mide el modelo con Brier, calibración y error del total |
| `npm run verify:bsb` | **Béisbol**: recuenta una temporada y la compara con el registro oficial |
| `npm run update-data:naf` | **Fútbol americano**: equipos, resultados, líneas de cierre y calendario |
| `npm run backtest:naf` | **Fútbol americano**: mide el modelo **contra la línea de cierre real** |
| `npm run backtest:fb` | **Fútbol**: mide el modelo con RPS y calibración del empate (`--model elo` mide el camino de respaldo) |
| `npm run audit` | **Los cuatro**: comprueba que los números que muestra la app son coherentes entre sí |
| `npm run verify:data` | Comprueba los **datos** contra hechos de cada deporte: partidos por temporada, cuánto gana el local, marcadores posibles, y que los Elo se reproduzcan |
| `npm run study:ablation` | Apaga cada pieza del modelo de tenis y mide cuánto empeora al quitarla. Registra los seis resultados |
| `npm run study:points` | **Modelo jerárquico de puntos**: ajusta saque/resto por jugador con ajuste por rival y δ por superficie, y lo mide cara a cara contra el modelo de Elo |
| `npm run study:live` | **Motor en vivo**: mide μ y κ del saque, y valida la cadena de Markov contra una simulación independiente |
| `npm run study:correlation` | **Mide la correlación entre posiciones abiertas** con residuos tipificados fuera de muestra, con grupo de control y bootstrap por bloques. `--record` lo anota en el registro |
| `npm run staking` | **La capa de decisión**: Kelly fraccional, topes, límites de pérdida y drawdown esperado |
| `npm run study:calibration` | Mide el ECE por deporte y escribe lo que el módulo de riesgo lee para dimensionar |
| `npm run experiments` | **El registro**: cuántas veces se han mirado estos datos, y qué resultados sobreviven a la corrección por comparaciones múltiples |
| `npm run study:baselines` | **Lo primero que hay que mirar**: el modelo contra la línea de cierre, contra solo la ventaja de local y contra un Elo pelado, con intervalos por bootstrap |
| `npm run study:devig` | Compara **multiplicativo vs. Shin vs. potencia** para quitar el margen de la casa, sobre 5.281 moneylines reales de la NFL |
| `npm run study:features` | Mide cada feature del modelo de fútbol por **log loss fuera de muestra**: lo que no se gana el sitio, fuera |
| `npm run study:sigma` | **Fútbol**: mide la escala del error del Elo (`ELO_SIGMA_C`), que fija el «± pp» de todas las tarjetas |
| `npm run study:dc` | **Fútbol**: el Dixon-Coles jerárquico contra el modelo de Elo, con walk-forward, y los mercados que salen de la rejilla (over/under, ambos marcan, hándicap) |
| `npm run study:postprocess` | **La capa entre el modelo y la pantalla**: ajusta la calibración (Platt vs. isotónica), el peso de la mezcla con el mercado y el encogimiento, y escribe `experiments/postprocess.json` |
| `npm run study:thin` | **Mercados de menos liquidez**: mide la dispersión de cada conteo, ajusta la ν de la COM-Poisson y puntúa los mercados de mitades contra el modelo anterior |
| `npm run news` | **El pipeline de noticias**: extrae estructura del texto libre con la API de Anthropic, la empareja con jugadores y mete las ausencias en la λ. `--text "..."` para un texto pegado, `--show` para ver qué le hace a cada partido |
| `npm run latency` | **La latencia del escáner de líneas**, desglosada por etapa con su dueño, contra un objetivo declarado. `--probe` comprueba si el proveedor ofrece WebSocket; `--prune N` poda las muestras viejas |
| `npm run doctor` | Diagnostica por qué la app muestra **cuotas de demostración**: `.env`, clave, cuota y qué hay guardado |
| `npm run build` | Build de producción del frontend + typecheck del backend |
| `npm run typecheck` | Chequeo de tipos de ambos workspaces |
| `npm run lint` | Lint real (oxlint, solo la categoría **correctness**) |
