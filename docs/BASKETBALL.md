# 🏀 Cómo funciona el modelo de baloncesto

Mismo principio que el de tenis (ver [MODEL.md](MODEL.md)): **todo se expresa en puntos Elo**, así
que cualquier probabilidad se puede rastrear hasta las señales que la produjeron. Código:
`server/src/basketball/`.

Los deportes están **separados de arriba abajo** — tablas, modelo, endpoints y pestaña propios. No
es por comodidad: tenis y baloncesto discrepan justo en los campos que un modelo necesita. Un
partido de tenis no tiene equipo local ni margen de puntos que merezca modelarse; un partido de
baloncesto tiene ambos y no tiene superficie. Un esquema único haría todas las columnas opcionales
y todas las consultas condicionales. Lo que sí generaliza (las matemáticas del mercado, la idea de
fiabilidad, el registro de predicciones) se reutiliza tal cual.

---

## 1. Las cuatro diferencias que hay que modelar

### a) Ventaja de campo

El local de la NBA gana **~60%** de los partidos. Es, de largo, la señal más importante:

| Ventaja de campo | Accuracy | Brier | Log loss |
|---|---|---|---|
| 0 (sin ventaja) | 65.7% | 0.2148 | 0.6184 |
| 60 pts Elo | 68.4% | 0.2027 | 0.5907 |
| 80 | 68.5% | 0.2014 | 0.5873 |
| **100 (elegida)** | **68.4%** | **0.2012** | **0.5868** |
| 120 | 68.2% | 0.2022 | 0.5891 |

Quitarla cuesta **0.0136 de Brier** — más que todo lo demás junto. Se aplica solo al calcular la
probabilidad, **nunca se guarda en el rating**: si se guardara, se contaría otra vez el siguiente
partido en casa. En **cancha neutral** (finales, copas, la burbuja de 2020) no se aplica.

### b) Margen de puntos

Ganar de 25 dice algo que ganar de 1 no dice. La K se escala con el margen, usando la formulación
de FiveThirtyEight:

```
mult = (margen + 3)^0.8 / (7.5 + 0.006 · brecha_Elo_del_ganador)
```

El numerador premia las palizas con rendimientos decrecientes. El **denominador** es la mitad
importante: crece con lo favorito que ya era el ganador, así que un equipo fuerte arrollando a uno
débil mueve menos que una paliza sorpresa. Sin ese freno, los ratings de los buenos equipos se
escapan de la realidad.

| Margen | Brier | Log loss |
|---|---|---|
| desactivado | 0.2027 | 0.5903 |
| a media fuerza | 0.2016 | 0.5879 |
| **completo (elegido)** | **0.2012** | **0.5868** |

### c) Temporadas: el arrastre

En tenis los jugadores no se traspasan. En baloncesto una plantilla puede cambiar por completo en
un verano, así que entre temporadas cada rating se **acerca a la media de la liga**:

```
Elo_nuevo = 1500 + (Elo_viejo − 1500) · 0.75
```

| Arrastre | Brier | Log loss |
|---|---|---|
| 1.00 (sin regresión) | 0.2020 | 0.5888 |
| 0.85 | 0.2014 | 0.5872 |
| **0.75 (elegido)** | **0.2012** | **0.5868** |
| 0.65 | 0.2012 | 0.5869 |
| 0.50 | 0.2016 | 0.5879 |

### d) Descanso y back-to-back

A diferencia del tenis, esto afecta a casi todos los partidos, no a un caso raro de vuelta de
lesión:

```
0 días (jugó ayer) → −35 pts Elo
1 día  (lo normal) →   0
2 días             →  +10
3–6 días           →  +12
≥ 7 días           →   0   ← ya no es "descanso"
```

El último tramo es deliberado: pasada una semana el hueco deja de significar «descansado» y empieza
a significar algo que el modelo no ve (parón de la liga, sanción, fuera de temporada, o simplemente
que los datos terminan ahí). Dar un bonus por eso sería premiar la ignorancia.

---

## 2. Las tres cifras que produce

**Ganador (moneyline)**

```
rating_local     = Elo_local + ajuste_descanso
rating_visitante = Elo_visitante + ajuste_descanso
P(gana local)    = 1 / (1 + 10^(−(rating_local + 100 − rating_visitante)/400))
```

**Diferencia (spread).** La brecha de Elo se convierte en puntos a **28 Elo = 1 punto**:

| Elo por punto | Error absoluto medio | Sesgo |
|---|---|---|
| 22 | 9.31 pts | +0.99 |
| 25 | 9.22 | +0.43 |
| **28 (elegido)** | **9.20** | **−0.00** |
| 31 | 9.23 | −0.36 |
| 34 | 9.27 | −0.65 |

28 da a la vez el menor error y **sesgo cero**. Aviso importante que la app repite en pantalla: el
error típico es de **~9 puntos**, así que la diferencia estimada es el centro de un rango ancho, no
una línea de apuesta afinada.

**Total de puntos.** De las medias de anotar y recibir de ambos equipos, encogidas hacia la media de
la liga para que una muestra pequeña no produzca totales absurdos. Está declarado como lo que es:
**no es un modelo de ritmo** — sin datos de posesiones no hay una medida real de tempo. El marcador
mostrado se recentra sobre la diferencia esperada, que está mucho mejor medida, para que las dos
cifras nunca se contradigan.

---

## 3. Calibración

A diferencia del tenis, la curva Elo cruda **ya está bien calibrada** en baloncesto (factor 1.0):

| Cuando el modelo dice… | …gana realmente | Error |
|---|---|---|
| 55.0% | 53.8% | −1.2 pp |
| 65.0% | 64.5% | −0.5 pp |
| 74.9% | 74.7% | −0.1 pp |
| 84.5% | 84.8% | +0.3 pp |
| 92.3% | 92.9% | +0.5 pp |

Tiene sentido: un partido de baloncesto son ~100 posesiones por equipo, así que el resultado es
mucho menos ruidoso que un partido de tenis, donde un solo break decide un set. Aun así el factor
es ajustable (`npm run backtest:bb -- --calibration <n>`) por si otra liga lo necesita.

---

## 4. Verificación: contra FiveThirtyEight

El backtest es *walk-forward* (cada partido se predice solo con lo anterior) y no reimplementa las
reglas: **conduce el mismo `replayGames` que usa la app**, engachando su callback por partido. Así
los números siempre describen el modelo que se está sirviendo, no una copia que se fue desviando.

Medido sobre **36.965 partidos NBA reales** (1985–2015, dataset de FiveThirtyEight):

| Métrica | Este modelo | Referencia |
|---|---|---|
| **Accuracy** | **68.4%** | «gana el local»: 61.6% |
| **Brier** | **0.2012** | 0.25 = decir siempre 50/50 |
| **Log loss** | **0.5868** | 0.693 = decir siempre 50/50 |
| **Error de margen** | **9.20 pts** | sesgo −0.00 |

Y lo más exigente: el propio dataset incluye **la predicción que FiveThirtyEight publicó** antes de
cada partido, así que se pueden comparar en los mismos 36.965 partidos:

| | Accuracy | Brier |
|---|---|---|
| Este modelo | 68.4% | **0.2012** |
| FiveThirtyEight | 68.4% | 0.2014 |

Empate técnico. No es «mejor que 538» — es que un Elo bien construido con ventaja de campo, margen y
descanso llega prácticamente al mismo sitio que su modelo público sobre estos partidos.

```bash
npm run backtest:bb                     # con los parámetros de la app
npm run backtest:bb -- --home 0         # sin ventaja de campo, para medir cuánto aporta
npm run backtest:bb -- --mov 0 --rest 0 # Elo pelado
npm run backtest:bb -- --from 2000      # otra ventana de evaluación
```

---

## 5. Fiabilidad por predicción

Igual que en tenis: cada probabilidad viene con un semáforo y un rango, derivados de cuántos
partidos respaldan cada Elo y de si los datos del equipo están viejos. Es propagación de error de
primer orden con una escala de ruido puesta a mano, **no** un posterior bayesiano, y se declara así.

En baloncesto el aviso de datos viejos importa **más** que en tenis: un rating de la temporada
pasada describe a una plantilla que puede haber cambiado de arriba abajo. Si los resultados
terminan hace más de 4 meses, la app lo dice en grande en vez de presentar Elo obsoletos como si
fueran actuales.

---

## 6. Fuentes de datos

| Para qué | Fuente | Notas |
|---|---|---|
| Resultados actuales + equipos | [ESPN API pública](https://site.api.espn.com) | Gratis, sin key. Cubre NBA, WNBA y NCAA (M y F). Se piden ~30 peticiones por temporada (calendario por equipo) en vez de ~250 (marcador por día). |
| Histórico profundo NBA | [FiveThirtyEight `nba-elo`](https://github.com/fivethirtyeight/data/tree/master/nba-elo) | 59.008 partidos reales 1946–2015 con marcador, local/visitante/neutral y playoffs. Es con lo que se **ajusta y valida** el modelo. **Termina en 2015**, así que nunca es la fuente de los ratings de hoy. |
| Partidos próximos + cuotas | [The Odds API](https://the-odds-api.com) | La misma key que usa el tenis. Descubre qué ligas de baloncesto están activas ahora en vez de asumir un calendario fijo. |

**Ligas sin fuente de resultados** (EuroLeague, NBL): la app muestra sus partidos y las
probabilidades **implícitas del mercado**, y dice claramente que no hay modelo Elo, en vez de
inventar una predicción. Es el mismo criterio que en tenis con un jugador sin historial.

**Aviso de verificación:** el entorno donde se desarrolló esto no alcanza ESPN ni The Odds API
(solo GitHub), así que esas dos integraciones están probadas contra respuestas capturadas en su
formato real y leídas de forma defensiva: si el formato no cuadra, fallan diciendo qué faltaba en
vez de escribir filas vacías. El modelo, en cambio, está ajustado y medido sobre datos NBA reales
descargados de verdad.
