# TODO — cierre de Fase 1

## Limitaciones conocidas de la Fase 1 (revisar antes de seguir)

- [ ] **Rangos intradía (1D/5D) pendientes.** El gráfico cubre 1M–10A con
      barras diarias/semanales. Intradía requiere decidir intervalo (5min/15min)
      y su coste en créditos de Twelve Data.
- [ ] **yfinance no distingue "símbolo inexistente" de "red caída"**: devuelve
      DataFrames vacíos en ambos casos, así que un fallo de red con yfinance
      como única fuente viva puede mostrarse como 404. Con Finnhub/Twelve Data
      configurados el caso es marginal, pero conviene afinarlo.
- [ ] **Twelve Data tiene también límite de 8 llamadas/min** además del diario;
      el limiter solo modela una ventana por proveedor. Añadir soporte de
      ventanas múltiples.
- [ ] **La moneda de la cotización de Finnhub llega vacía** (su /quote no la
      incluye); la UI la toma del perfil. Unificar en el backend.
- [ ] **SMA/RSI sobre barras semanales** (rangos 5A/10A) se calculan sobre el
      intervalo mostrado, como hacen las plataformas de charting — documentado,
      pero revisar si prefieres SMA diarias siempre.
- [ ] Limpieza periódica de `api_cache` expirado y de `api_call_log` viejo
      (hoy solo crecen; para uso personal tardará en importar).

## Fase 2 — análisis fundamental completo

- [ ] Provider SEC EDGAR (companyfacts + submissions JSON; sin key, con
      User-Agent identificado) para estados financieros históricos.
- [ ] Provider FRED para macro (tasas, curva, inflación, desempleo).
- [ ] Provider Alpha Vantage (con su límite de 25/día bien protegido).
- [ ] Ratios completos: EV/EBITDA, ROIC, FCF, crecimiento 5A desde estados
      financieros (no solo el TTM que da Finnhub).
- [ ] DCF por escenarios con supuestos editables + análisis de sensibilidad.
- [ ] Altman Z-score, Piotroski F-score, cobertura de intereses (con tests
      contra casos calculados a mano).
- [ ] Comparativa contra pares del sector con percentiles.
- [ ] Insider trading (Forms 3/4/5) desde EDGAR.
- [ ] Dashboard de mercado: índices, sectores, VIX, curva de rendimientos.
- [ ] Paneles RSI/MACD como subgráficos bajo el precio (los datos ya se
      calculan y viajan en el API).

## Infraestructura pendiente

- [ ] Alembic cuando el esquema empiece a migrar con datos valiosos dentro.
- [ ] Considerar WebSocket de Finnhub para cotizaciones en vivo sin gastar
      llamadas REST (lo incluye el tier gratuito).
- [ ] Script `make dev` / docker-compose opcional para levantar todo junto.
