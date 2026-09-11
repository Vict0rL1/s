# Prompt: el motor de predicción

Solo el interior. Sin interfaz, sin despliegue, sin historial del proyecto. Todos los
números de aquí están sacados del código, no redondeados de memoria.

---

## El encargo

> Construye el **motor de predicción** de una aplicación deportiva: los modelos, su
> ajuste, su validación y la capa que convierte una probabilidad en una decisión de
> apuesta. Cinco deportes: fútbol, baloncesto, béisbol, fútbol americano y tenis.
>
> **Dos reglas mandan sobre todo lo demás:**
>
> 1. **Nada se publica sin medirlo cara a cara contra lo que ya había.** Si un modelo
>    nuevo pierde, se dice el número y no se sustituye. Si una señal no separa, se borra.
> 2. **Un fallo nunca puede parecer un acierto.** Sin datos no se pinta un aprobado, se
>    pinta «sin medir». Un modelo ajustado dice de cuándo es.

---

## 1. Elo de tenis (por jugador y por superficie)

Base 1500. La probabilidad sale de la diferencia con el divisor clásico:

```
P(gana i) = 1 / (1 + 10^(−Δ/400))
```

**K decreciente con la experiencia**, no constante:

```
K(n) = 250 / (n + 5)^0.4
```

Un jugador con 4 partidos se mueve mucho; uno con 400, poco. Esa es toda la regularización
que necesita un Elo bien planteado.

**Margen de victoria.** El Elo pelado solo ve quién ganó, pero 6-0 6-0 y 7-6 6-7 7-6 dicen
cosas distintas. K se escala por la cuota de juegos ganados del vencedor, **centrada en la
media observada de 0,615** (no en 0,5, que inflaría todas las K), con peso 4 y recorte a
[0,6 · 1,5].

**Cuatro Elos por jugador**: general, dura, tierra y hierba. Al predecir se mezcla

```
Elo_usado = 0.7 · Elo_superficie + 0.3 · Elo_general
```

El 0,7 es el peso de superficie medido, no elegido.

**Ajustes que se suman al Elo antes de la probabilidad:**

| ajuste | fórmula | tope |
|---|---|---|
| forma | ventana de 10 partidos con decay 0,85 por paso atrás | ±40 |
| descanso | 0 hasta 7 días, crece hasta 90 días | −60 |
| cara a cara | encogido hacia cero con `k=4` encuentros | — |

**Calibración final**: la diferencia de Elo se multiplica por `0.75` antes de convertirla
a probabilidad. Un Elo sin calibrar sale sistemáticamente demasiado seguro; ese factor se
ajustó sobre el histórico.

**Fiabilidad.** Cada predicción publica su margen (±pp), derivado de:
`σ_Elo = 250/√n` por jugador, más `40 σ por año` de antigüedad del último partido (tope
120). Menos de 10 partidos = sin confianza; 60 = alta. Margen < 3,5 pp alta, > 8 pp baja.

**Resultado medido:** 67,0 % de acierto frente al 64,8 % de fiarse del ranking oficial.
Cuando discrepa del ranking, acierta el 55,4 % — que es la única cifra que dice si aporta
algo.

---

## 2. Modelo jerárquico de puntos (tenis)

Estima, para cada jugador, P(ganar punto al saque) y P(ganar punto al resto), **ajustados
por la calidad del rival**. No sirve restar medias de carrera: esas se midieron contra los
rivales que a cada uno le tocaron.

**Ajuste conjunto para todo el circuito**, por descenso de gradiente con L2:

```
logit P(i gana punto sacando contra j) = μ_superficie + s_i − r_j
```

- La identificabilidad viene **de la penalización L2**: sumar una constante a todas las `s`
  y restarla de todas las `r` deja la verosimilitud igual.
- El gradiente se normaliza por los puntos de cada jugador: `w = max(puntos_saque, 50)`.
- **Decay temporal con vida media de 365 días**, medido en un barrido: 0,64957 de log loss
  contra 0,66037 sin decay y 0,65170 con 180 días.
- **Deltas por superficie encogidos hacia el perfil global** del jugador según los partidos
  que tenga en ella. λ = 0,20 es el mejor del barrido.

**Propagación por cadena de Markov**: punto → juego → tiebreak → set → partido.

- Deuce: `P = p²/(p² + (1−p)²)`.
- Ventaja: se reduce decrementando ambos marcadores mientras sean ≥ 4.
- Tiebreak: el patrón de saque es `floor((t+1)/2) % 2 === 0 ? abridor : el otro`.
- A 6-6 la forma cerrada es `p1(1−p2) / (p1(1−p2) + (1−p1)p2)`, porque `p1·(1−p2)` conmuta.
- Soporta best-of-3 y best-of-5 y **las variantes de tiebreak del set final por torneo y
  época** (antes de 2019 solo el US Open; 2019-2021 cada Grand Slam la suya; desde 2022 los
  cuatro a 10 puntos).
- Se promedia sobre ambos primeros sacadores, porque el saque lo decide un sorteo.

**Rendimiento**: la enumeración ingenua da un nodo por camino (14⁵ ≈ 537.000 estados,
2.229 ms por partido a 5 sets = 3,7 h por temporada). **Fusionando estados equivalentes**
—clave `s1|s2|g1|g2|abridor`— y cacheando la enumeración de sets baja a **7 ms**. Factor
318.

### El resultado, que es la parte importante

Walk-forward sobre 5.667 partidos ATP desde 2024, reajuste trimestral:

| modelo | log loss |
|---|---|
| **Elo con superficie** | **0,558** |
| puntos, mejor de 8 configuraciones | 0,663 |
| puntos, peor de las 8 | 0,680 |

**Pierde, y no se publica como modelo de partido.** 0,680 está a un paso del 0,693 de una
moneda. Las tasas de punto agregadas tiran la información de quién ganó: se puede ganar el
63 % de los puntos al saque y perder el partido por haber perdido los importantes.

**Lo que sí aporta**: set, hándicap de juegos y total de juegos, los tres derivados de la
**misma** distribución, así que no pueden contradecirse entre sí. En total de juegos,
0,674 contra 0,724 de la marginal.

---

## 3. Motor en vivo (tenis)

Probabilidad de victoria desde el marcador exacto (sets, juegos, puntos, quién saca), con
la misma cadena.

**Actualización bayesiana del saque dentro del partido** (Beta-Binomial):

```
p_post = (κ·μ + k) / (κ + n)
```

con **κ = 63 puntos**, medido por descomposición de varianza. Es lo que hace que un jugador
que va sacando muy por debajo de su media se actualice en vez de ignorarse, sin que tres
puntos malos lo tiren todo.

**Propiedad que hay que documentar, no «arreglar»**: con el marcador empatado (0-0, 3-3,
5-5) la probabilidad del set es la misma saque quien saque. Es real, y está comprobado
contra una simulación independiente de 800.000 sets. La reacción natural al verlo es
arreglarlo, y arreglarlo rompería un modelo correcto.

**Momentum tras un quiebre: se detecta y se enseña, pero NO se ajusta.** No existen datos
punto a punto para medirlo, y ajustar por algo no medido es inventar.

---

## 4. Fútbol: Dixon-Coles jerárquico

Ataque y defensa por equipo con **priors que encogen hacia la media de la liga**, ventaja
de campo propia y decay temporal. Corrección ρ para los cuatro marcadores bajos (0-0, 1-0,
0-1, 1-1), acotada a |ρ| ≤ 0,2.

De ahí sale la **rejilla de marcadores exactos**, y de la rejilla todos los mercados 1X2,
over/under y hándicap — nunca un modelo por mercado.

### Las dos mitades: de 8,35 pp de error a 2,08

1. **Un Dixon-Coles por mitad**, cada uno con su ataque, defensa, ventaja y ρ. Un equipo
   que sale fuerte y se apaga no se describe con un solo par de números.
2. **COM-Poisson en vez de Poisson.** Los goles de una mitad están *infra*dispersos:
   medido sobre 24.778 partidos, un equipo se queda a cero en la primera parte el 47,93 %
   de las veces y la Poisson dice 51,98 %. La ν se ajusta por máxima verosimilitud.
3. Cópula entre mitades, porque no son independientes.

### Lesiones y alineaciones

Las ausencias entran **en la λ esperada**, no en un recuadro decorativo. Un pipeline con
un LLM extrae estructura de texto libre (ruedas de prensa, partes médicos) y devuelve
ausencias con su probabilidad de jugar; las reglas simples cubren el 80 % de los casos sin
gastar nada. Alineación confirmada y esperada se distinguen. La rotación por calendario
**avisa, no ajusta**.

---

## 5. NFL, baloncesto y béisbol

| | NFL | Baloncesto | Béisbol |
|---|---|---|---|
| Elo inicial | 1500 | 1500 | 1500 |
| K | 18 | 20 | **5** |
| Ventaja de campo | 55 Elo, adaptativa (α = 1/512) | 100 Elo | 24 Elo |
| Arrastre entre temporadas | 0,60 | 0,75 | 0,80 |
| Puntos por Elo | 20 | σ del margen = 11,7 | 0,25 carreras/Elo |

**NFL.** El único deporte donde el modelo se puede puntuar **contra la línea de cierre**,
porque nflverse la publica. Sobre 7.261 partidos, el favorito de la línea gana el 66,2 % y
el Brier de la línea es **0,2127** — ese es el listón. Lleva rating específico del
**quarterback titular**: cambiar de QB mueve la línea más que casi nada.

Cuatro señales se midieron y **se dejaron en cero** porque no separaban, con la constante
visible en el código en vez de borrada: descanso por día, semana de descanso, escala
divisional en casa y temperatura sobre el total. Dejarlas en cero y no eliminarlas es
deliberado: la próxima persona que piense «esto debería ayudar» encuentra la constante y
el motivo, en vez de volver a implementarlo.

**Béisbol.** El modelo se construye alrededor del **lanzador abridor**: 4,4 carreras de
liga por apertura, regresión con 15 aperturas de peso. **Park factors** por estadio.
Dispersión de carreras 4,5 y cuota de local 0,505; entradas extra 0,53 para el local.

**Baloncesto.** Publica la **distribución del margen**, no solo el ganador: σ = 11,7 puntos
sobre 6 temporadas.

---

## 6. La capa entre el modelo y la pantalla

Tres pasos, en este orden, cada uno medido por separado:

1. **De-vig.** Quitar el margen de la casa antes de comparar. Se midió Shin contra el
   multiplicativo; gana el multiplicativo y es el que se usa.
2. **Calibración de Platt** sobre las probabilidades del modelo, con ECE como métrica.
3. **Mezcla con el mercado** en espacio logit, con encogimiento. El peso no se elige: se
   ajusta.

**Umbral de valor**: 5 pp de diferencia con el mercado. Y **por profundidad de mercado**:
el mínimo base es 4 % de ventaja, multiplicado según la liquidez — a un mercado fino hay
que exigirle más porque su precio es peor referencia y su margen mayor.

---

## 7. Modelo y decisión son dos cosas

Una probabilidad no es una apuesta. La decisión pasa por ocho puertas y cada una puede
tumbarla:

```
kellyFraction        0.25     Kelly fraccional, nunca completo
maxPerEvent          2 %      del banco
minEdge              2 %      por debajo no se juega
dailyLossLimit       5 %
weeklyLossLimit      10 %
maxTotalExposure     10 %     cinco apuestas al tope simultáneas
maxExposurePerDay     6 %     tres al tope: el día es donde se concentra una racha
maxExposurePerLeague  5 %     que el banco no dependa de UNA liga
```

**El tamaño baja solo cuando el modelo está peor calibrado**: el multiplicador sale del ECE
medido, no de una opinión.

### Kelly de cartera, no por apuesta aislada

Con posiciones simultáneas, la suma de Kellys individuales sobrestima lo que se puede
arriesgar. Se resuelve con la aproximación cuadrática (Markowitz) al crecimiento
logarítmico, `f* = Σ⁻¹μ`, con conjunto activo para la no-negatividad.

**La correlación se midió antes de implementarla, y salió lo contrario de lo esperado:**

| pares | ρ |
|---|---|
| partidos distintos, misma liga y jornada | **≈ 0** (validado con grupo de control) |
| mercados distintos **del mismo partido** | **0,19** |

La primera versión mezclaba los dos grupos y daba un ρ=0,019 «significativo» que en
realidad medía 1X2 contra over del mismo marcador. Al separarlos, uno colapsó a cero.

El error estándar **no puede ser el ingenuo**: los pares no son observaciones
independientes. Bootstrap por bloques sobre jornadas.

Y se evalúa el **drawdown**, no solo el retorno: dos estrategias con el mismo retorno
esperado y distinto drawdown máximo no son la misma estrategia.

---

## 8. Cómo validar (y esto no es opcional)

- **Walk-forward fuera de muestra**, con reajuste periódico. Nada de evaluar sobre lo que
  se ajustó.
- **Tres conjuntos, no dos**: entrenamiento, validación y un **holdout cerrado por código**
  que solo se abre una vez.
- **Registro de experimentos** con corrección por comparaciones múltiples (Bonferroni **por
  familia de métrica**, no un divisor global que infle el umbral de todos).
- **Baselines obligatorios**: el modelo contra el mercado, contra una constante y contra un
  Elo pelado. Un modelo que no bate a los tres no ha demostrado nada.
- **Track record propio**: cada predicción servida se guarda con su probabilidad y sus
  cuotas del momento, **no se reescribe nunca**, y se puntúa cuando llega el resultado —
  con el mismo cálculo aplicado al mercado en esos mismos partidos.

### Y la parte que más vale: probar las comprobaciones

**Cada comprobación nueva se valida inyectando su bug.** Si al romper el código a propósito
el check no falla, el check no sirve y hay que reescribirlo.

Tres ejemplos reales de este proyecto, los tres encontrados así:

- Un check de latencia **vacuo**: sin muestras el total es 0, no se pasa del objetivo, y la
  bandera salía falsa con y sin la guarda que debía comprobar.
- El mismo check **dependiendo del contenido de la base**: el total suma el p95 por etapa,
  así que con la tabla vacía una muestra inyectada *era* el p95, y con la tabla poblada
  caía entre doscientas y no movía nada. No daba falso verde: rompía, por el andamio.
  Solución: separar la decisión de la lectura en una función pura.
- Rompí el cálculo de la ventaja en el tenis y **ningún check falló**, porque desde 0-0 la
  recursión nunca visita una ventaja (deuce cortocircuita) y la identidad `5-4 = 4-3` pasa
  por la misma rama rota. Solución: comprobar valores, no solo identidades.

---

## 9. Errores de implementación que costará caros repetir

- **El generador de números aleatorios.** Un LCG con `seed * 1103515245` desborda 2^53 en
  float64 y queda sesgado: P(x<0,62) daba 0,627 y los nueve casos de cadena «discrepaban»,
  incluido el valor de libro. Usa **mulberry32 con `Math.imul`**, y comprueba la media del
  generador **antes** de que valide nada.
- **Un λ enorme no «apaga» un término**: hace divergir el descenso. 2.003 de 3.126 deltas
  no finitos, logLik NaN, devuelto en silencio. Pon un interruptor explícito y una guarda
  que lance si `λ·learningRate ≥ 2`.
- **Comprueba la finitud después de ajustar.** Un ajuste divergido devuelve números
  perfectamente creíbles.
- **Una clave compuesta hay que ordenarla.** `over_under~btts` escrito a mano nunca casaba
  con `btts~over_under`, así que la mayor de tres correlaciones usaba en silencio el valor
  por defecto.
- **El signo de un factor de correlación no es un detalle**: cambiado, recorta lo que había
  que dejar y deja lo que había que recortar, y por fuera parece igual de prudente.
- **Investiga antes de arreglar.** Dos veces aquí lo que parecía un fallo era el
  comportamiento correcto, y «arreglarlo» habría roto un modelo que funcionaba.
