# Checklist de Release Candidate 1

Base: `e3265f5` → `f338493` · 22 commits · tests 826 → **1108** (todos en verde)
· puntos abiertos en `TODO.md` 32 → **28**

Este documento separa dos cosas que no deben mezclarse: lo que está
**automatizado y verificado** —hay un test que falla si se rompe— y lo que
**solo se puede verificar a mano**, porque depende de una API real, de una
máquina con escritorio o de tu broker. Lo segundo no está hecho: este entorno
no tiene claves de API ni salida de red a ninguna fuente financiera.

Un sistema con 1108 tests en verde no está «listo para producción»: está
probado contra lo que sus tests saben imaginar. Lo que no saben imaginar es lo
que está en la segunda mitad de este documento.

---

## Automatizado y verificado

### Tests
- [x] Suite completa: **1108 passed** (`cd backend && python -m pytest tests/`)
- [x] La suite NO toca `backend/data/app.db` — `test_aislamiento.py`; verificado
      además comparando la fecha de modificación del fichero antes y después
- [x] Frontend: `tsc --noEmit` y `npm run build` sin errores
- [x] Test de extremo a extremo con la pila real (caché, router, validación,
      base migrada) y siete escenarios A–G — `test_e2e_ciclo.py`

### Migraciones
- [x] Alembic 0001–0006; la app migra sola al arrancar y **no arranca** si no puede
- [x] 0001 idempotente: repara columnas ausentes en bases creadas con `create_all()`
- [x] Una base antigua **con datos** migra sin perder una fila — comprobado campo a campo
- [x] Filas que violan una restricción nueva **paran** la migración; no se borran
- [x] Deshacer 0001, o 0004/0006 con datos dentro, se niega
- [x] El esquema migrado coincide con los modelos (`compare_metadata`)

### Caché
- [x] Un payload inválido (precio `None`/`NaN`/0/negativo, histórico vacío) no
      se cachea y **cede el turno** a la siguiente fuente
- [x] Si todas las fuentes fallan, se sirve la última copia **marcada** `viejo`,
      con su antigüedad; demasiado vieja → error, no dato
- [x] El estado del dato llega al cliente (los `response_model` lo filtraban)
- [x] …y se VE: «DATO VIEJO · hace N min» en cada bloque con fuente (antes, una
      cotización rescatada salía rotulada «en vivo»); «viejo · N min» junto a
      cada precio de la cartera, con un aviso en el resumen — verificado en el
      navegador con las fuentes caídas de verdad
- [x] Estados financieros de EDGAR validados: NaN e infinitos fuera; signos
      imposibles (capex negativo, que inflaría el FCF) fuera; `filed_at` intacto
- [x] Limpieza automática al arrancar y en cada pasada del cron; respeta el
      margen de rescate
- [x] TTL por tipo de dato en `config.py` (cotización 60 s, histórico 6 h,
      histórico largo 7 días, macro 24 h, fundamentales, noticias…)

### Alertas
- [x] Cuatro estados distintos: cumplida · no cumplida · sin datos · error
- [x] Una alerta rota no tumba la revisión de las demás
- [x] Última evaluación, último resultado, último error y fallos seguidos, por alerta
- [x] Un reintento ante proveedores caídos; ninguno en peticiones del navegador
- [x] Anti-spam: 12 pasadas en 3 h con la condición cumplida → **un** aviso
- [x] Tres revisiones seguidas sin poder comprobar → **un** aviso de error, con
      enfriamiento de 24 h y rearme al recuperarse
- [x] Alertas duplicadas no se crean dos veces
- [x] Con un precio viejo, «no cumplida» pasa a «sin comprobar»; «cumplida» salta
      diciendo la antigüedad

### Divisas
- [x] Reciprocidad: USD→CAD→USD = identidad; CAD/USD = 1/(USD/CAD); cruces no-USD
- [x] Dirección de cada serie de FRED escrita a mano y comprobada con fixtures
      deterministas (ninguna con valores de mercado reales)
- [x] Toda serie configurada tiene banda de cordura (lo único que para un NaN de FRED)
- [x] Moneda desconocida → **fuera del total**, nunca «supongo dólar»
- [x] Moneda resuelta cotización → instrumento → perfil, y guardada
- [x] Cada conversión deja traza: par, tipo efectivo, fecha del tipo, serie
- [x] Coste de compra al tipo del día de compra; efecto divisa separado
- [x] P&L realizado: lo cobrado al tipo de venta menos lo pagado al de compra
- [x] `/riesgo` convierte antes de pesar
- [x] Todos los universos de la lista diaria cotizan en dólares (invariante)

### Cartera
- [x] Posición sin precio: fuera de los totales, nombrada, no vale cero
- [x] Cantidad o coste infinitos, fechas imposibles o futuras → 422, no 500
- [x] Doble clic → 409; segundo lote real con `confirmar_duplicado`
- [x] Cantidad > 0 y coste ≥ 0 también en la base (CHECK)
- [x] Fechas servidas siempre con zona horaria

### Sizing
- [x] Cada límite (posición, sector, correlación, volatilidad) declara si se
      aplicó; un límite no aplicado se ve en pantalla y queda en el registro
- [x] Una volatilidad `NaN` ya no anula el objetivo de volatilidad
- [x] Una volatilidad ausente se supone **alta** (≥ la peor medida), no se excluye
- [x] 5 posiciones correlacionadas: 25 %; 5 independientes: 45 %
- [x] 8 ideas al 12,5 % no dan 100 %
- [x] Una idea buena puede recibir 0 % porque no cabe, y se dice por qué

### Motor de decisión
- [x] Precio `NaN`, infinito, negativo, cero o texto → `sin_datos`, con lo que falta
- [x] Puntuación `NaN` → `sin_datos`, no «ni destaca ni preocupa»
- [x] El stop de una posición se **fija al abrir**; ya no se aleja con la
      volatilidad de la propia caída
- [x] Las posiciones antiguas pueden fijarlo («Fijar stop»); un stop se puede
      subir, nunca bajar — verificado en el navegador
- [x] No se recomienda comprar sobre un precio viejo (pasa a «vigilar»); sobre
      una posición abierta se decide igual, diciéndolo
- [x] Valoración: deuda, capex o acciones desconocidos → sin valor por acción
      (422 con el arreglo), nunca «deuda cero»
- [x] Crecimiento supuesto marcado como supuesto, no como dato

### Proveedores de datos
- [x] Una fuente que dice «no lo tengo» no corta la cadena de fallback
- [x] «No existe» solo si lo dicen todas las fuentes consultadas
- [x] Proveedor caído → siguiente; todos caídos → error o dato viejo marcado

### Validación de estrategia
- [x] El holdout no se mira desde la interfaz; solo con el script y la frase
      de confirmación, y queda registrado
- [x] El corte del holdout es fijo; ninguna ventana lo mueve
- [x] Cada ejecución (script o interfaz) queda como experimento → recuento del
      Sharpe deflactado correcto
- [x] Sin mirada al futuro en SMA, volatilidad, entrada y fundamentales
- [x] Comparación contra comprar-y-mantener, equiponderada, momentum 12m e
      índice externo, con CAGR, volatilidad, Sharpe, máxima caída, rotación,
      costes pagados y exposición; y con operaciones, tasa de acierto (con
      intervalo), esperanza y factor de beneficio
- [x] El veredicto dice «NO SUPERA AL BASELINE» cuando no lo supera
- [x] Los backtests guardados antes del RC1 (calculados mirando el holdout) ya no
      validan decisiones; solo cuenta uno guardado con su partición

### Registro de decisiones y forward testing
- [x] Cada lista diaria congela lo accionable con la señal entera
- [x] Instantáneas inmutables: ORM + triggers de SQLite + huella SHA-256
- [x] Resultados en filas nuevas; una cuenta cerrada no se reabre
- [x] `GET /api/snapshots/{id}` reconstruye «por qué dijo esto aquel día»

### Registro (logging)
- [x] Nueve categorías bajo `app.` (proveedor, validacion, dato, calculo, db,
      cache, alertas, llm, riesgo); nivel con `APP_LOG_LEVEL`
- [x] Ningún `except` convierte un fallo en un cero. Los que quedan sobre fallos
      de proveedor (curva de tipos, pares, tendencia de ETFs…) dejan el dato en
      `None` —se pinta «—»— y el router ya ha registrado el fallo en
      `app.proveedor`. Lo que no hacen es explicar en pantalla POR QUÉ falta;
      eso queda como mejora (P2), no como fallo abierto.

### Interfaz
- [x] Los errores de validación (422) muestran su motivo; antes solo «Error HTTP 422»

### Seguridad
- [x] `.env` y `backend/data/` en `.gitignore`; ningún commit los incluye
- [x] Logos: solo https, solo IP públicas, sin redirecciones, tamaño acotado
- [x] Instantáneas sin endpoint de escritura; holdout sin endpoint de apertura

---

## Requiere verificación manual

Ninguno de estos se puede hacer desde este entorno. **Son bloqueadores del
RC1**: sin ellos, lo que el sistema congele en forward testing podría ser un
registro fiel de datos mal leídos.

- [ ] **Tipo de cambio real.** Con tu `FRED_API_KEY`, abre la cartera con una
      posición canadiense y comprueba en el panel de divisas que
      **1 USD ≈ 1,3–1,4 CAD** (no ≈ 0,7). Si sale al revés, la dirección de
      `DEXCAUS` en `fx.SERIES` está mal y todo lo convertido también.
- [ ] **Notificación de escritorio con la app cerrada.** Programa
      `scripts/revisar_alertas.py` en cron (o launchd), crea una alerta que
      tenga que saltar, cierra la app y espera a la siguiente pasada. Tiene que
      aparecer el globo; y en `~/.alertas.log`, la línea de la alerta.
- [ ] **Contrastar 2-3 tickers contra tu broker**: precio, P/E, márgenes, deuda
      neta. Es la primera vez que la app se ejecutaría contra las APIs reales
      desde que existe la frontera de validación.
- [ ] **EDGAR contra un 10-K conocido.** Que deuda, caja, capex y acciones en
      circulación cuadren con el último 10-K de una empresa que conozcas. El
      capex en particular: el parser solo reconoce dos etiquetas XBRL, y ahora
      un capex no encontrado deja la valoración en 422 en vez de inflarla.
- [ ] **Un DCF a mano** una vez, para ver el número salir en pantalla y cuadrar.
- [ ] **Ejecutar el backtest de reglas con datos reales** y leer el veredicto:
      `python scripts/run_rule_backtest.py --hipotesis "..." --anos 8`. Este
      entorno no pudo; nadie sabe todavía si el sistema bate a no hacer nada.
- [ ] **Migrar TU base real.** La primera vez que arranques esta versión, la app
      migrará `backend/data/app.db`. Haz antes una copia del fichero. Si la
      migración 0002 se niega por posiciones con cantidad ≤ 0 o coste < 0, te
      dirá cuáles: corrígelas a mano y vuelve a arrancar.

---

## Tareas programadas recomendadas

```cron
# Alertas: cada 15 min en horario de mercado de EE. UU. (horas en UTC)
*/15 13-21 * * 1-5  cd /ruta/al/repo/backend && /usr/bin/python3 scripts/revisar_alertas.py >> ~/.alertas.log 2>&1
# Forward testing: medir las instantáneas una vez al día, tras el cierre
30 22 * * 1-5       cd /ruta/al/repo/backend && /usr/bin/python3 scripts/evaluar_instantaneas.py >> ~/.instantaneas.log 2>&1
```
