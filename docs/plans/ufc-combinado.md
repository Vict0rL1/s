# UFC: un segundo intento, registrado antes de mirar

Escrito y subido **antes** de calcular nada. La UFC no pasó la prueba de publicación (ver
[../UFC.md](../UFC.md)): el Elo de luchador gana a la moneda, a «más peleas» y al Elo básico, pero
no queda demostrado que gane a «el de mejor récord» (en todo lo puntuable Δ −0,0028 [−0,0056,
+0,0000]; en 2025, +0,0038). Este es el segundo y último intento con estos datos. Si no pasa, la UFC
se queda en sombra y no se buscan más variantes hasta que haya algo nuevo (más temporadas o cuotas
para medir contra el mercado).

## Qué se prueba

Una regresión logística **sin término independiente** (así es simétrica: dar la vuelta a los dos
luchadores da la vuelta a la probabilidad) sobre diferencias entre los dos, todas con lo que se
sabía antes de la pelea:

| Rasgo | Qué es |
|---|---|
| `elo` | la diferencia de Elo del modelo vigente, en logit (Δ × ln 10 / 400) |
| `record` | logit(récord suavizado de uno) − logit(del otro), el récord de la referencia que no se ganó |
| `edad` | diferencia de edad el día de la pelea, en décadas (0 si falta una fecha de nacimiento) |
| `alcance` | diferencia de alcance, por 10 cm (0 si falta una medida) |
| `experiencia` | ln(1 + peleas en la UFC) de uno menos el del otro |

Dos candidatos, fijados aquí y ninguno más:

- **C1, Elo + récord**: `elo`, `record`.
- **C2, Elo + récord + ficha**: los cinco.

Penalización L2 fija, λ = 1 (no se ajusta). Las fechas de nacimiento y el alcance son de la ficha de
ufcstats: no cambian con el tiempo, así que no traen información del futuro. Que falte una medida
no se usa como rasgo, porque que falte depende en parte de cuánto peleó después el luchador.

## Cómo se evalúa

- **Walk-forward por año**: las predicciones del año Y salen de una logística ajustada solo con las
  peleas decididas de los años anteriores (desde 1994, calentamiento incluido). Así todas las
  predicciones puntuadas son fuera de muestra.
- **Se puntúan exactamente las mismas peleas** que en la prueba anterior (tras 500 de calentamiento,
  victorias de peleas atribuidas, sin el holdout).
- **Elección entre C1 y C2**: el menor log loss en los años de entrenamiento (puntuables, antes de
  2025). 2025 no se mira para elegir.
- **La prueba para publicar, una vez, con el elegido**: la misma regla de antes. Gana a las cuatro
  referencias (moneda, más peleas, mejor récord, Elo básico) con el intervalo del bootstrap
  emparejado por debajo de cero, **en todo lo puntuable y en 2025 por separado**. Y, para cambiar el
  modelo vigente, mejora al Elo solo en 2025 con el intervalo por debajo de cero.
- **2026 en adelante es el holdout**: no entra ni en el ajuste ni en la puntuación.

Los dos resultados (la elección y la prueba) van al registro de experimentos, salga lo que salga.

## Resultado

`npm run backtest:ufc -- --combinado --registrar`, una vez, el 8 de octubre de 2026 (8.923 peleas, la
última del 3 de octubre de 2026).

**Elección (entrenamiento, → 2024):** C1 Elo + récord 0,67955; **C2 Elo + récord + ficha 0,66766,
elegido.** Pesos del ajuste que predice 2025: Elo 0,613 · récord 0,149 · edad −0,676 por década ·
alcance 0,094 por 10 cm · experiencia 0,135.

**La prueba, todo lo puntuable sin holdout (7.799 peleas):** log loss **0,6662** (Brier 0,2367,
acierto 59,5 %, ECE 0,48 pp).

| Referencia | Log loss | Δ [IC 95 %] |
|---|---|---|
| Moneda al aire | 0,6931 | −0,0269 [−0,0321, −0,0216] |
| Más peleas en la UFC | 0,6944 | −0,0281 [−0,0331, −0,0230] |
| Mejor récord en la UFC | 0,6830 | −0,0168 [−0,0211, −0,0124] |
| Elo básico | 0,6842 | −0,0180 [−0,0221, −0,0139] |
| Elo de luchador solo (el vigente) | 0,6802 | −0,0140 [−0,0179, −0,0103] |

**Solo 2025 (501 peleas):** log loss **0,6454**. Moneda −0,0478 [−0,0665, −0,0293]; más peleas
−0,0527 [−0,0720, −0,0339]; mejor récord −0,0271 [−0,0435, −0,0110]; Elo básico −0,0375 [−0,0532,
−0,0219]; Elo solo −0,0309 [−0,0461, −0,0157].

**Pasa**: gana a las cuatro referencias con el intervalo por debajo de cero en los dos tramos, y
mejora al Elo solo en la validación. Los dos experimentos están en el registro (`shipped`).

### Comprobaciones hechas después (diagnóstico, no cambian la elección)

- **El peso de la edad es estable**: −0,56 a −0,68 por década en cada ajuste anual desde 2007; no
  es un año raro.
- **Barajar las fichas entre luchadores borra la ganancia**: con las fechas de nacimiento y los
  alcances repartidos al azar, el log loss vuelve a 0,6804 (el Elo solo, 0,6802). La mejora sale de
  la ficha de cada uno, no de un artificio de los datos.
- **Crece con la diferencia** (casi monótono): el más joven gana el 52,3 % con menos de 2 años de
  diferencia, 57,0 % con 2-4, 56,1 % con 4-6 y 63,3 % con más de 6.
- **Lo que no se puede medir**: no hay cuotas históricas de la UFC alcanzables. Como en la NHL, la
  comparación con el mercado solo se podrá hacer hacia delante, con el registro en vivo.

**Publicada** el mismo día: séptimo deporte, con pestaña, tarjeta de pelea, ficha de luchador,
registro, banco y el resto de piezas comunes ([../UFC.md](../UFC.md)).
