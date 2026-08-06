# TODO — estado tras completar las cinco fases

## ⚠️ Lo primero: verificar con datos reales

Nada de esto se ha podido probar contra las APIs reales (el entorno donde se
programó bloquea la salida a internet financiero). Antes de confiar en un
número:

- [ ] Correr con tus keys y **contrastar 2-3 tickers contra tu broker**:
      precio, P/E, márgenes, deuda neta.
- [ ] Verificar que los estados financieros de EDGAR cuadran con el último
      10-K de una empresa que conozcas bien. El parser XBRL elige la primera
      etiqueta con datos anuales; empresas con contabilidad atípica pueden
      mapear mal alguna partida.
- [ ] Comprobar el DCF a mano una vez (los tests lo verifican, pero conviene
      que veas el número salir en pantalla y te cuadre).

## Limitaciones conocidas

### Datos
- [ ] **Sin intradía (1D/5D).** Los rangos van de 1M a 10A con barras diarias
      o semanales. Añadirlo cuesta créditos de Twelve Data.
- [ ] **EDGAR solo cubre empresas registradas en la SEC.** Una acción europea
      o canadiense sin ADR no tendrá estados financieros ni filings.
- [ ] **Composición de ETFs limitada a ~10 holdings** (única fuente gratuita).
      El solapamiento calculado es una cota inferior; la UI lo advierte pero
      conviene tenerlo presente al decidir.
- [ ] **yfinance no distingue "símbolo inexistente" de "red caída"**: puede
      mostrarse un 404 cuando en realidad falló la red.
- [ ] **Sin datos de propiedad institucional (13F).** EDGAR los publica pero
      requiere parsear otro formato; hoy solo se listan los Forms 3/4/5 con
      enlace, sin desglose de importes por transacción.

### Análisis
- [ ] **Altman Z no aplica a bancos ni financieras.** Se avisa en la UI, pero
      la app no lo bloquea: no interpretes el número en esos casos.
- [ ] **ROIC usa una tasa impositiva fija del 21 %** (visible en la UI). Para
      empresas con tasa efectiva muy distinta, el ROIC quedará sesgado.
- [ ] **La beta se calcula siempre contra SPY.** Para una acción canadiense o
      europea, ese benchmark no es el adecuado.
- [ ] **SMA/RSI en rangos 5A/10A se calculan sobre barras semanales**, como
      en las plataformas de charting. Documentado, pero revisa si prefieres
      SMA diarias siempre.
- [ ] **El registro de aciertos solo evalúa dirección y magnitud del error.**
      Con pocas observaciones el azar domina — el propio resumen lo dice, pero
      no calcula significancia estadística.

### Motor de señales
- [ ] **El backtest tendrá pocas observaciones.** Con fundamentales anuales de
      EDGAR, 8 empresas y 6 años salen ~150 observaciones repartidas en 5
      rangos. Es probable que ningún rango llegue a las 30 necesarias y el
      modelo siga sin calibrar. **Esto es correcto, no un fallo**: significa
      que no hay evidencia suficiente para publicar probabilidades. Para
      calibrarlo de verdad hacen falta 30-50 empresas y 10+ años.
- [ ] **Universo pequeño = z-scores inestables.** Con 8 empresas, añadir o
      quitar una cambia todas las puntuaciones. Es una comparación relativa,
      no una medida absoluta.
- [ ] **Sin ajuste por sector.** Comparar el P/E de un banco con el de una
      tecnológica penaliza injustamente a la segunda. Lo correcto es puntuar
      dentro de cada sector; requiere universos más grandes.
- [ ] **El factor de sentimiento no está validado.** Entra en la señal en vivo
      (10 % del peso) pero se excluye del backtest por falta de histórico, así
      que su tasa de acierto es desconocida.
- [ ] **Sin costes de transacción ni deslizamiento** en el backtest. Una
      estrategia con rebalanceo trimestral pagaría comisiones que aquí no se
      descuentan.
- [ ] **Sesgo de supervivencia**: el universo lo eliges tú hoy, con empresas
      que existen hoy. Un backtest riguroso incluiría las que quebraron.

### Informe de analista
- [ ] **Los múltiplos históricos usan EPS y patrimonio ANUALES**, no TTM
      trimestral: la serie de P/E es escalonada (salta al publicarse cada
      10-K) en vez de suave. Suficiente para situar el percentil, no para
      comparar con un terminal profesional.
- [ ] **Sin desglose por segmento ni concentración de clientes**: EDGAR no lo
      expone estructurado en companyfacts. Para eso hay que leer el 10-K.
- [ ] **Riesgos solo cuantitativos.** Los umbrales detectan apalancamiento,
      cobertura, compresión de márgenes y valoración exigente. Competencia,
      regulación, calidad de la gestión o riesgo de disrupción no salen de las
      cifras — la UI lo dice, pero no lo suple.
- [ ] **Catalizadores limitados a lo que hay en los datos**: próximos
      resultados, filings recientes y eventos de noticias clasificados. No
      cubre vencimientos de patentes, litigios en curso ni días del inversor.
- [ ] El DCF precargado acota el crecimiento al 15 % y usa WACC fijos por
      escenario (9/10/12 %). Es un punto de partida, no una valoración
      afinada: edítalo en la pestaña Valoración.

### Producto
- [ ] **Las alertas no notifican**: se evalúan cuando abres la pestaña. Es una
      app local sin proceso en marcha. Un cron + notificación de escritorio
      sería el siguiente paso.
- [ ] **Una sola watchlist** ("Principal"). El esquema soporta varias.
- [ ] **Sin divisas.** Una posición en CAD y otra en USD se suman como si
      fueran la misma moneda. Si mezclas mercados, esto es lo primero que hay
      que arreglar.
- [ ] **Sin historial de precios de la cartera**: el P&L es puntual, no hay
      curva de valor en el tiempo.

## Mejoras pendientes

- [ ] Limpieza periódica de `api_cache` expirado y `api_call_log` viejo (hoy
      solo crecen; para uso personal tardará en importar).
- [ ] Alembic cuando el esquema empiece a migrar con datos valiosos dentro.
- [ ] WebSocket de Finnhub para cotizaciones en vivo sin gastar llamadas REST
      (lo incluye el tier gratuito).
- [ ] Paneles RSI/MACD como subgráficos bajo el precio (los datos ya viajan en
      el API, solo falta dibujarlos).
- [ ] Editar tesis existentes (hoy se crean y se borran).
- [ ] Exportar el portafolio y las tesis a CSV/Markdown.
- [ ] Detección de eventos en noticias (resultados, guidance, ratings) —
      quedó fuera de la Fase 3 por coste de API.
- [ ] `make dev` o docker-compose para levantar backend y frontend juntos.
