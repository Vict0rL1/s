# NHL y UFC

Petición: añadir la NHL y la UFC. Mismo método que las fases: plan, commits pequeños, todo en verde
antes de cada uno, y la regla de la Fase 8 —**un deporte no se publica sin la misma evidencia que
los demás**— por delante.

## Lo que se encontró al empezar (8 de octubre de 2026)

- La NHL ya existía en sombra (Fase 8.1): ingesta desde `api-web.nhle.com`, Elo con Poisson,
  backtest y holdout desde la 2025-26. Pero la tabla estaba vacía: esa API, la vieja
  `statsapi.web.nhl.com`, MoneyPuck y Hockey-Reference están bloqueadas desde este entorno.
- **Sí se alcanza GitHub.** Ahí hay dos fuentes con historia real:
  - NHL: los calendarios por temporada de sportsdataverse (2009-10 → la actual), copia de la API de
    la NHL.
  - UFC: `Greco1899/scrape_ufc_stats`, que rasca ufcstats.com y se actualiza (8.950 combates hasta
    la UFC 332, 3 de octubre de 2026).
- Cuotas: The Odds API cubre las dos (`icehockey_nhl`, `mma_mixed_martial_arts`), pero está
  bloqueada aquí. Cuotas históricas de ninguna de las dos: no hay comparación con el mercado (igual
  que el tenis y el fútbol).

## Etapa A: datos y evidencia

### NHL

1. Segunda fuente en `server/src/nhl/ingest.ts` (`--fuente sportsdataverse`, la de por defecto):
   un CSV por temporada. No dice si hubo prórroga o tanda: `final_period` pasa a admitir NULL
   (migración 14, que rehace la tabla copiando las filas) y se añade `fuente`. El marcador final de
   la NHL ya cuenta la prórroga o la tanda como un gol, que es como cuenta los totales el modelo.
2. **Hallazgo**: nueve temporadas del calendario (2009-10 a 2012-13, 2018-19 a 2022-23) traen
   marcadores de relleno (todos «3-2», o el local que gana siempre). Con ellos el backtest daba
   0,70 de log loss, peor que una moneda. Se detectan (`marcadoresDegenerados`) y se arreglan con
   las «team box» de la misma fuente, cruzadas por orden de fecha **solo si los dos equipos
   coinciden en todos los partidos**; si falla uno, la temporada no se guarda. Las nueve cruzaron
   enteras.
3. Ajuste por el registro (`npm run backtest:nhl -- --ajustar --registrar`): rejilla de K, ventaja
   de campo y vuelta a la media entre temporadas, elegida en 2009-10 → 2023-24; validación una vez
   en la 2024-25; el holdout (2025-26 →) no se puntúa.
4. La prueba para publicar (docs/NHL.md, paso 3): el modelo contra las dos referencias, partido a
   partido, con bootstrap emparejado.

### UFC

5. Módulo nuevo `server/src/ufc/`: tablas de historia (combates y luchadores), ingesta de los CSV de
   Greco1899, un Elo de luchador, backtest walk-forward contra referencias y holdout propio.
   Interruptor `deportes.ufc`, apagado. En `DEPORTES_SOMBRA` hasta que pase la misma prueba.

## Etapa B: publicar lo que pase

Entrar en `SPORT_IDS` (pestañas, Destacados, registro de predicciones, banco, cuotas) solo para el
deporte que gane a sus referencias fuera de muestra. Lo que no pase se queda en sombra, con sus
cifras en Diagnóstico.

## Resultados de la etapa A, NHL

21.960 partidos (18 temporadas). Con los parámetros de partida, sin ajustar:

| | Log loss (20.214 partidos puntuables, 2009-10 → 2024-25) |
|---|---|
| Modelo (Elo con margen + Poisson) | **0,6731** (ECE 1,45 pp) |
| Siempre el local (tasa histórica) | 0,6896 · Δ −0,0165 [−0,0193, −0,0135] |
| Elo básico | 0,6805 · Δ −0,0073 [−0,0090, −0,0057] |

Gana a las dos con el intervalo lejos del cero: **pasa la prueba de publicación**. El ajuste no
mejora de forma demostrable a los valores de partida (validación 2024-25: −0,0025 [−0,0055,
+0,0006], p 0,11; registrado como no concluyente) ni los goles de la liga móviles mejoran los
totales: se quedan los de partida.

## Resultados de la etapa A, UFC

8.923 peleas (791 eventos, hasta la UFC 332 del 3 de octubre de 2026), 7.799 puntuables de 2005 a
2025. Detalle en [UFC.md](../UFC.md).

| | Log loss | Δ modelo − referencia |
|---|---|---|
| Modelo (Elo de luchador, valores de partida) | **0,6802** | |
| Moneda al aire | 0,6931 | −0,0130 [−0,0166, −0,0092] |
| Más peleas en la UFC | 0,6944 | −0,0142 [−0,0181, −0,0101] |
| Mejor récord en la UFC | 0,6830 | −0,0028 [−0,0056, +0,0000] |
| Elo básico | 0,6842 | −0,0040 [−0,0057, −0,0023] |

En 2025 sola (501 peleas), «mejor récord» queda por delante (+0,0038 [−0,0088, +0,0171]). **No pasa
la prueba**: la UFC se queda en sombra, con sus cifras en Diagnóstico. La rejilla tampoco mejora de
forma demostrable a los valores de partida (validación: −0,0017 [−0,0045, +0,0013], p 0,25).

## Etapa B: lo que se publicó

**La NHL**, que pasó. Entró en `SPORT_IDS` con todo lo que tienen los otros cinco: pestaña, tarjeta,
registro de predicciones en el libro mayor (migraciones 16 y 17), Hoy, ¿Acertó?, Destacados, banco
de papel y estrategias, confianza, pre-partido, evaluación en vivo, archivo, búsqueda, historia del
Elo, versiones, doctor, auditoría, `update-results`, `update-all` y los backtests nocturnos. El
backtest de referencia escribe la capa común, la calibración con bandas de acierto y el
walk-forward. Decisiones:

- Sin post-proceso ni mezcla con el mercado: no hay cuotas históricas con las que ajustarlos. La
  diferencia con la casa se enseña como desacuerdo, no como valor.
- El total de goles está en la tarjeta pero no en «lo más probable»: sale de una media de la liga
  fija y repetía «menos de 6,5» al 55 % en cada partido.
- El banco reprecia con la cuota de ahora (como siempre) y no exige que la predicción tuviera precio
  al registrarse: en la NHL casi todas se registran desde el calendario, antes de que haya cuota.
- Sin simulación de temporada (calendario de 30 días; la clasificación da un punto por la derrota en
  la prórroga, que el archivo no dice). La página de liga enseña el Elo.
- Escudos neutros: el conjunto abierto de colores pone a casi todos los equipos en negro y no tiene
  a Seattle ni a Utah.

**La UFC**, que no pasó, se quedó en sombra con sus cifras en Diagnóstico. Un segundo intento,
registrado antes de calcular ([ufc-combinado.md](ufc-combinado.md)), sí pasó: la UFC se publicó como
séptimo deporte ([../UFC.md](../UFC.md)).
