// ============================================================================
// Æ FUSED RELAY — worker.js
// Final, First edition
// ============================================================================
// Lossless fusion of:
//   (1) ÆEA-era multi-provider market-data relay
//   (2) ÆI-era generic crawler fetch relay
//
// Both share a single entry point, a single X-Relay-Key gate, and a single
// /health endpoint. Route selection is by query-param presence:
//
//   GET /?url=<https-url>
//        →  crawler fetch. Returns the page title, a SHA-256 hash of the
//           page's plain text, and the outbound links. Stateless. Blocks
//           private IPs. This is what app.py's CrawlerRelayClient consumes.
//
//   GET /?symbol=<S>&kind=<price|volume|intraday|history|candles>
//                    &interval=<tf>&limit=<n>
//        →  market data. Dispatches:
//             crypto          → Kraken → Binance → CoinGecko → Yahoo
//             equities/futures→ Stooq  → Yahoo
//             forex/indices   → Yahoo only
//           This is what app.py's MarketTickWorker MAY consume (see the
//           app.py MarketTickWorker relay-first patch in the companion
//           segment) and what any fork should consume for the
//           multi-provider fallback advantage.
//
//   GET /health
//        →  public liveness. No auth. Reports both capabilities.
//
// Rules shared across both routes:
//   - If env.RELAY_KEY is set (wrangler secret put RELAY_KEY), every
//     non-/health request must carry `X-Relay-Key: <value>`.
//   - CORS: Access-Control-Allow-Origin "*", Allow-Headers includes
//     Content-Type, Accept, X-Relay-Key. Max-Age 86400.
//   - OPTIONS * returns 204 with CORS headers.
//   - Only GET / OPTIONS allowed on routes other than implicit preflight.
//
// No backend URL is embedded in this file. The Worker is the backend
// boundary; it does not know or need the Heroku URL. The Heroku app
// knows the Worker URL via RELAY_URL env var.
// ============================================================================

// ---------------------------------------------------------------------------
// CONSTANTS — shared
// ---------------------------------------------------------------------------
const UA_CRAWLER = "AE-Fused/1.0 (+https://aeindex.example/; contact=ops@example.com) Mozilla/5.0 (compatible; AE-Fused-Crawler/1.0)";
const FETCH_TIMEOUT_MS = 30000;
const MAX_HTML_BYTES = 768 * 1024;
const MAX_LINKS = 64;
const ALLOWED_PROTOCOLS = ["http:", "https:"];
const BLOCKED_HOST_SUBSTRINGS = [
    "127.0.0.1",
    "localhost",
    "169.254.",
    "metadata.google.internal",
    "::1",
    "0.0.0.0"
];
const BLOCKED_PRIVATE_PREFIXES = ["10.", "192.168.", "172."];

// ---------------------------------------------------------------------------
// CONSTANTS — market providers
// ---------------------------------------------------------------------------
const YAHOO_HOST = "https://query1.finance.yahoo.com";
const COINGECKO_HOST = "https://api.coingecko.com/api/v3";
const BINANCE_HOST = "https://api.binance.com";
const KRAKEN_HOST = "https://api.kraken.com/0/public";
const STOOQ_HOST = "https://stooq.com/q/l/";
const UA_MARKET = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// ============================================================================
// CRYPTO MAP — fused (union of Kraken + Binance + CoinGecko live triples)
// ============================================================================
const CRYPTO_MAP = {
    "BTC-USD":  { kraken: "XBTUSD",  binance: "BTCUSDT",  gecko: "bitcoin",           stooq: "btcusd" },
    "ETH-USD":  { kraken: "ETHUSD",  binance: "ETHUSDT",  gecko: "ethereum",          stooq: "ethusd" },
    "XRP-USD":  { kraken: "XRPUSD",  binance: "XRPUSDT",  gecko: "ripple",            stooq: "xrpusd" },
    "ADA-USD":  { kraken: "ADAUSD",  binance: "ADAUSDT",  gecko: "cardano",           stooq: "adausd" },
    "SOL-USD":  { kraken: "SOLUSD",  binance: "SOLUSDT",  gecko: "solana",            stooq: "solusd" },
    "DOGE-USD": { kraken: "DOGEUSD", binance: "DOGEUSDT", gecko: "dogecoin",          stooq: "dogeusd" },
    "LTC-USD":  { kraken: "LTCUSD",  binance: "LTCUSDT",  gecko: "litecoin",          stooq: "ltcusd" },
    "LINK-USD": { kraken: "LINKUSD", binance: "LINKUSDT", gecko: "chainlink",         stooq: "linkusd" },
    "DOT-USD":  { kraken: "DOTUSD",  binance: "DOTUSDT",  gecko: "polkadot",          stooq: "dotusd" },
    "AVAX-USD": { kraken: "AVAXUSD", binance: "AVAXUSDT", gecko: "avalanche-2",       stooq: "avaxusd" },
    "MATIC-USD":{ kraken: "MATICUSD",binance: "MATICUSDT",gecko: "matic-network",     stooq: "maticusd" },
    "UNI-USD":  { kraken: "UNIUSD",  binance: "UNIUSDT",  gecko: "uniswap",           stooq: "uniusd" },
    "ATOM-USD": { kraken: "ATOMUSD", binance: "ATOMUSDT", gecko: "cosmos",            stooq: "atomusd" },
    "NEAR-USD": { kraken: "NEARUSD", binance: "NEARUSDT", gecko: "near",              stooq: "nearusd" },
    "FIL-USD":  { kraken: "FILUSD",  binance: "FILUSDT",  gecko: "filecoin",          stooq: "filusd" },
    "ETC-USD":  { kraken: "ETCUSD",  binance: "ETCUSDT",  gecko: "ethereum-classic",  stooq: "etcusd" },
    "ICP-USD":  { kraken: "ICPUSD",  binance: "ICPUSDT",  gecko: "internet-computer", stooq: "icpusd" },
    "XLM-USD":  { kraken: "XLMUSD",  binance: "XLMUSDT",  gecko: "stellar",           stooq: "xlmusd" },
    "HBAR-USD": { kraken: "HBARUSD", binance: "HBARUSDT", gecko: "hedera-hashgraph",  stooq: "hbarusd" },
    "QNT-USD":  { kraken: "QNTUSD",  binance: "QNTUSDT",  gecko: "quant-network",     stooq: "qntusd" },
    "GRAM-USD": { kraken: "TONUSD",  binance: "TONUSDT",  gecko: "the-open-network",  stooq: "" },
    "TON-USD":  { kraken: "TONUSD",  binance: "TONUSDT",  gecko: "the-open-network",  stooq: "" },
    "ARB-USD":  { kraken: "ARBUSD",  binance: "ARBUSDT",  gecko: "arbitrum",          stooq: "" },
    "OP-USD":   { kraken: "OPUSD",   binance: "OPUSDT",   gecko: "optimism",          stooq: "" },
    "SUI-USD":  { kraken: "SUIUSD",  binance: "SUIUSDT",  gecko: "sui",               stooq: "" },
    "APT-USD":  { kraken: "APTUSD",  binance: "APTUSDT",  gecko: "aptos",             stooq: "" },
    "INJ-USD":  { kraken: "INJUSD",  binance: "INJUSDT",  gecko: "injective-protocol",stooq: "" },
    "TIA-USD":  { kraken: "TIAUSD",  binance: "TIAUSDT",  gecko: "celestia",          stooq: "" },
    "SEI-USD":  { kraken: "SEIUSD",  binance: "SEIUSDT",  gecko: "sei-network",       stooq: "" },
    "STX-USD":  { kraken: "",        binance: "STXUSDT",  gecko: "blockstack",        stooq: "" },
    "IMX-USD":  { kraken: "IMXUSD",  binance: "IMXUSDT",  gecko: "immutable-x",       stooq: "" },
    "MINA-USD": { kraken: "MINAUSD", binance: "MINAUSDT", gecko: "mina-protocol",     stooq: "" },
    "FLOW-USD": { kraken: "FLOWUSD", binance: "FLOWUSDT", gecko: "flow",              stooq: "" },
    "EGLD-USD": { kraken: "EGLDUSD", binance: "EGLDUSDT", gecko: "elrond-erd-2",      stooq: "" },
    "XTZ-USD":  { kraken: "XTZUSD",  binance: "XTZUSDT",  gecko: "tezos",             stooq: "" },
    "ALGO-USD": { kraken: "ALGOUSD", binance: "ALGOUSDT", gecko: "algorand",          stooq: "" },
    "VET-USD":  { kraken: "VETUSD",  binance: "VETUSDT",  gecko: "vechain",           stooq: "" },
    "THETA-USD":{ kraken: "",        binance: "THETAUSDT",gecko: "theta-token",       stooq: "" },
    "FTM-USD":  { kraken: "FTMUSD",  binance: "FTMUSDT",  gecko: "fantom",            stooq: "" },
    "ONE-USD":  { kraken: "ONEUSD",  binance: "ONEUSDT",  gecko: "harmony",           stooq: "" },
    "ZIL-USD":  { kraken: "ZILUSD",  binance: "ZILUSDT",  gecko: "zilliqa",           stooq: "" },
    "KSM-USD":  { kraken: "KSMUSD",  binance: "KSMUSDT",  gecko: "kusama",            stooq: "" },
    "GLMR-USD": { kraken: "",        binance: "GLMRUSDT", gecko: "moonbeam",          stooq: "" },
    "MOVR-USD": { kraken: "",        binance: "MOVRUSDT", gecko: "moonriver",         stooq: "" },
    "ASTR-USD": { kraken: "",        binance: "ASTRUSDT", gecko: "astar",             stooq: "" },
    "CFX-USD":  { kraken: "",        binance: "CFXUSDT",  gecko: "conflux-token",     stooq: "" },
    "ROSE-USD": { kraken: "",        binance: "ROSEUSDT", gecko: "oasis-network",     stooq: "" },
    "KAVA-USD": { kraken: "KAVAUSD", binance: "KAVAUSDT", gecko: "kava",              stooq: "" },
    "CELO-USD": { kraken: "",        binance: "CELOUSDT", gecko: "celo",              stooq: "" },
    "IOTX-USD": { kraken: "",        binance: "IOTXUSDT", gecko: "iotex",             stooq: "" },
    "CKB-USD":  { kraken: "",        binance: "CKBUSDT",  gecko: "nervos-network",    stooq: "" },
    "AR-USD":   { kraken: "",        binance: "ARUSDT",   gecko: "arweave",           stooq: "" },
    "DYM-USD":  { kraken: "",        binance: "DYMUSDT",  gecko: "dymension",         stooq: "" },
    "ALT-USD":  { kraken: "",        binance: "ALTUSDT",  gecko: "altlayer",          stooq: "" },
    "MANTA-USD":{ kraken: "",        binance: "MANTAUSDT",gecko: "manta-network",     stooq: "" },
    "ZK-USD":   { kraken: "",        binance: "ZKUSDT",   gecko: "zksync",            stooq: "" },
    "STRK-USD": { kraken: "STRKUSD", binance: "STRKUSDT", gecko: "starknet",          stooq: "" },
    "BLUR-USD": { kraken: "BLURUSD", binance: "BLURUSDT", gecko: "blur",              stooq: "" },
    "AAVE-USD": { kraken: "AAVEUSD", binance: "AAVEUSDT", gecko: "aave",              stooq: "" },
    "MKR-USD":  { kraken: "MKRUSD",  binance: "MKRUSDT",  gecko: "maker",             stooq: "" },
    "COMP-USD": { kraken: "COMPUSD", binance: "COMPUSDT", gecko: "compound-governance-token", stooq: "" },
    "CRV-USD":  { kraken: "CRVUSD",  binance: "CRVUSDT",  gecko: "curve-dao-token",   stooq: "" },
    "SNX-USD":  { kraken: "SNXUSD",  binance: "SNXUSDT",  gecko: "havven",            stooq: "" },
    "SUSHI-USD":{ kraken: "SUSHIUSD",binance: "SUSHIUSDT",gecko: "sushi",             stooq: "" },
    "YFI-USD":  { kraken: "YFIUSD",  binance: "YFIUSDT",  gecko: "yearn-finance",     stooq: "" },
    "BAL-USD":  { kraken: "BALUSD",  binance: "BALUSDT",  gecko: "balancer",          stooq: "" },
    "KNC-USD":  { kraken: "KNCUSD",  binance: "KNCUSDT",  gecko: "kyber-network-crystal", stooq: "" },
    "ZRX-USD":  { kraken: "ZRXUSD",  binance: "ZRXUSDT",  gecko: "0x",                stooq: "" },
    "BAT-USD":  { kraken: "BATUSD",  binance: "BATUSDT",  gecko: "basic-attention-token", stooq: "" },
    "ENJ-USD":  { kraken: "ENJUSD",  binance: "ENJUSDT",  gecko: "enjincoin",         stooq: "" },
    "MANA-USD": { kraken: "MANAUSD", binance: "MANAUSDT", gecko: "decentraland",      stooq: "" },
    "SAND-USD": { kraken: "SANDUSD", binance: "SANDUSDT", gecko: "the-sandbox",       stooq: "" },
    "AXS-USD":  { kraken: "AXSUSD",  binance: "AXSUSDT",  gecko: "axie-infinity",     stooq: "" },
    "GALA-USD": { kraken: "GALAUSD", binance: "GALAUSDT", gecko: "gala",              stooq: "" },
    "CHZ-USD":  { kraken: "CHZUSD",  binance: "CHZUSDT",  gecko: "chiliz",            stooq: "" },
    "APE-USD":  { kraken: "APEUSD",  binance: "APEUSDT",  gecko: "apecoin",           stooq: "" },
    "GMT-USD":  { kraken: "GMTUSD",  binance: "GMTUSDT",  gecko: "stepn",             stooq: "" },
    "LRC-USD":  { kraken: "LRCUSD",  binance: "LRCUSDT",  gecko: "loopring",          stooq: "" },
    "STORJ-USD":{ kraken: "STORJUSD",binance: "STORJUSDT",gecko: "storj",             stooq: "" },
    "ANKR-USD": { kraken: "ANKRUSD", binance: "ANKRUSDT", gecko: "ankr",              stooq: "" },
    "CVC-USD":  { kraken: "",        binance: "CVCUSDT",  gecko: "civic",             stooq: "" },
    "OMG-USD":  { kraken: "OMGUSD",  binance: "OMGUSDT",  gecko: "omisego",           stooq: "" },
    "REN-USD":  { kraken: "RENUSD",  binance: "RENUSDT",  gecko: "republic-protocol", stooq: "" },
    "LDO-USD":  { kraken: "LDOUSD",  binance: "LDOUSDT",  gecko: "lido-dao",          stooq: "" },
    "RPL-USD":  { kraken: "RPLUSD",  binance: "RPLUSDT",  gecko: "rocket-pool",       stooq: "" },
    "GMX-USD":  { kraken: "",        binance: "GMXUSDT",  gecko: "gmx",               stooq: "" },
    "DYDX-USD": { kraken: "DYDXUSD", binance: "DYDXUSDT", gecko: "dydx-chain",        stooq: "" },
    "PENDLE-USD":{ kraken: "PENDLEUSD",binance: "PENDLEUSDT",gecko: "pendle",         stooq: "" },
    "LQTY-USD": { kraken: "LQTYUSD", binance: "LQTYUSDT", gecko: "liquity",           stooq: "" },
    "ENS-USD":  { kraken: "ENSUSD",  binance: "ENSUSDT",  gecko: "ethereum-name-service", stooq: "" },
    "1INCH-USD":{ kraken: "1INCHUSD",binance: "1INCHUSDT",gecko: "1inch",             stooq: "" },
    "FET-USD":  { kraken: "FETUSD",  binance: "FETUSDT",  gecko: "fetch-ai",          stooq: "" },
    "GRT-USD":  { kraken: "GRTUSD",  binance: "GRTUSDT",  gecko: "the-graph",         stooq: "" },
    "PEPE-USD": { kraken: "PEPEUSD", binance: "PEPEUSDT", gecko: "pepe",              stooq: "" },
    "SHIB-USD": { kraken: "SHIBUSD", binance: "SHIBUSDT", gecko: "shiba-inu",         stooq: "" },
    "WIF-USD":  { kraken: "WIFUSD",  binance: "WIFUSDT",  gecko: "dogwifcoin",        stooq: "" },
    "BONK-USD": { kraken: "BONKUSD", binance: "BONKUSDT", gecko: "bonk",              stooq: "" },
    "FLOKI-USD":{ kraken: "FLOKIUSD",binance: "FLOKIUSDT",gecko: "floki",             stooq: "" },
    "BOME-USD": { kraken: "",        binance: "BOMEUSDT", gecko: "book-of-meme",      stooq: "" },
    "MOG-USD":  { kraken: "",        binance: "MOGUSDT",  gecko: "mog-coin",          stooq: "" },
    "JUP-USD":  { kraken: "JUPUSD",  binance: "JUPUSDT",  gecko: "jupiter-exchange-solana", stooq: "" },
    "PYTH-USD": { kraken: "PYTHUSD", binance: "PYTHUSDT", gecko: "pyth-network",      stooq: "" },
    "JTO-USD":  { kraken: "JTOUSD",  binance: "JTOUSDT",  gecko: "jito-governance-token", stooq: "" },
    "RNDR-USD": { kraken: "RNDRUSD", binance: "RNDRUSDT", gecko: "render-token",      stooq: "" },
    "WLD-USD":  { kraken: "WLDUSD",  binance: "WLDUSDT",  gecko: "worldcoin-wld",     stooq: "" },
    "ARKM-USD": { kraken: "ARKMUSD", binance: "ARKMUSDT", gecko: "arkham",            stooq: "" },
    "AI-USD":   { kraken: "",        binance: "AIUSDT",   gecko: "sleepless-ai",      stooq: "" },
    "TAO-USD":  { kraken: "",        binance: "TAOUSDT",  gecko: "bittensor",         stooq: "" },
    "BCH-USD":  { kraken: "BCHUSD",  binance: "BCHUSDT",  gecko: "bitcoin-cash",      stooq: "bchusd" },
    "XMR-USD":  { kraken: "XMRUSD",  binance: "XMRUSDT",  gecko: "monero",            stooq: "xmrusd" },
    "DASH-USD": { kraken: "DASHUSD", binance: "DASHUSDT", gecko: "dash",              stooq: "dashusd" },
    "ZEC-USD":  { kraken: "ZECUSD",  binance: "ZECUSDT",  gecko: "zcash",             stooq: "zecusd" },
    "EOS-USD":  { kraken: "EOSUSD",  binance: "EOSUSDT",  gecko: "eos",               stooq: "eosusd" },
    "TRX-USD":  { kraken: "TRXUSD",  binance: "TRXUSDT",  gecko: "tron",              stooq: "trxusd" },
    "NEO-USD":  { kraken: "NEOUSD",  binance: "NEOUSDT",  gecko: "neo",               stooq: "" },
    "IOTA-USD": { kraken: "IOTAUSD", binance: "IOTAUSDT", gecko: "iota",              stooq: "" },
    "QTUM-USD": { kraken: "QTUMUSD", binance: "QTUMUSDT", gecko: "qtum",              stooq: "" },
    "DGB-USD":  { kraken: "DGBUSD",  binance: "DGBUSDT",  gecko: "digibyte",          stooq: "" },
    "SC-USD":   { kraken: "SCUSD",   binance: "SCUSDT",   gecko: "siacoin",           stooq: "" },
    "RVN-USD":  { kraken: "RVNUSD",  binance: "RVNUSDT",  gecko: "ravencoin",         stooq: "" },
    "KAS-USD":  { kraken: "KASUSD",  binance: "KASUSDT",  gecko: "kaspa",             stooq: "" },
    "USDT-USD": { kraken: "USDTUSD", binance: "",         gecko: "tether",            stooq: "" },
    "USDC-USD": { kraken: "USDCUSD", binance: "USDCUSDT", gecko: "usd-coin",          stooq: "" },
    "DAI-USD":  { kraken: "DAIUSD",  binance: "DAIUSDT",  gecko: "dai",               stooq: "" },
    "BNB-USD":  { kraken: "",        binance: "BNBUSDT",  gecko: "binancecoin",       stooq: "" },
    "OKB-USD":  { kraken: "OKBUSD",  binance: "",         gecko: "okb",               stooq: "" },
    "HT-USD":   { kraken: "",        binance: "",         gecko: "huobi-token",       stooq: "" },
    "KCS-USD":  { kraken: "",        binance: "",         gecko: "kucoin-shares",     stooq: "" },
    "W-USD":    { kraken: "WUSD",    binance: "WUSDT",    gecko: "wormhole",          stooq: "" },
    "OMNI-USD": { kraken: "",        binance: "OMNIUSDT", gecko: "omni-network",      stooq: "" },
    "REZ-USD":  { kraken: "",        binance: "REZUSDT",  gecko: "renzo",             stooq: "" },
    "ETHFI-USD":{ kraken: "",        binance: "ETHFIUSDT",gecko: "ether-fi",          stooq: "" },
    "ENA-USD":  { kraken: "ENAUSD",  binance: "ENAUSDT",  gecko: "ethena",            stooq: "" },
    "EIGEN-USD":{ kraken: "",        binance: "EIGENUSDT",gecko: "eigenlayer",        stooq: "" },
    "MOVE-USD": { kraken: "",        binance: "MOVEUSDT", gecko: "movement",          stooq: "" },
    "ME-USD":   { kraken: "",        binance: "MEUSDT",   gecko: "magic-eden",        stooq: "" },
    "PNUT-USD": { kraken: "",        binance: "PNUTUSDT", gecko: "peanut-the-squirrel", stooq: "" },
    "ACT-USD":  { kraken: "",        binance: "ACTUSDT",  gecko: "act-i-the-ai-prophecy", stooq: "" },
    "GOAT-USD": { kraken: "",        binance: "GOATUSDT", gecko: "goatseus-maximus",  stooq: "" },
    "MOODENG-USD":{ kraken: "",      binance: "MOODENGUSDT",gecko: "moo-deng",       stooq: "" },
    "POPCAT-USD":{ kraken: "",       binance: "POPCATUSDT",gecko: "popcat",          stooq: "" },
    "NEIRO-USD":{ kraken: "",        binance: "NEIROUSDT",gecko: "neiro-3",          stooq: "" },
    "TURBO-USD":{ kraken: "",        binance: "TURBOUSDT",gecko: "turbo",            stooq: "" },
    "MEW-USD":  { kraken: "",        binance: "MEWUSDT",  gecko: "cat-in-a-dogs-world", stooq: "" },
    "BRETT-USD":{ kraken: "",        binance: "BRETTUSDT",gecko: "based-brett",      stooq: "" },
    "TOSHI-USD":{ kraken: "",        binance: "TOSHIUSDT",gecko: "toshi",            stooq: "" },
    "DEGEN-USD":{ kraken: "",        binance: "DEGENUSDT",gecko: "degen-base",       stooq: "" },
    "HIGH-USD": { kraken: "",        binance: "HIGHUSDT", gecko: "highstreet",        stooq: "" },
    "ID-USD":   { kraken: "",        binance: "IDUSDT",   gecko: "space-id",          stooq: "" },
    "EDU-USD":  { kraken: "",        binance: "EDUUSDT",  gecko: "open-campus",       stooq: "" },
    "HOOK-USD": { kraken: "",        binance: "HOOKUSDT", gecko: "hooked-protocol",   stooq: "" },
    "MAGIC-USD":{ kraken: "",        binance: "MAGICUSDT",gecko: "magic",             stooq: "" },
    "PIXEL-USD":{ kraken: "",        binance: "PIXELUSDT",gecko: "pixels",            stooq: "" },
    "PORTAL-USD":{ kraken: "",       binance: "PORTALUSDT",gecko: "portal",          stooq: "" },
    "AEVO-USD": { kraken: "",        binance: "AEVOUSDT", gecko: "aevo",              stooq: "" },
    "MASK-USD": { kraken: "",        binance: "MASKUSDT", gecko: "mask-network",      stooq: "" },
    "CYBER-USD":{ kraken: "",        binance: "CYBERUSDT",gecko: "cyberconnect",      stooq: "" },
    "RDNT-USD": { kraken: "",        binance: "RDNTUSDT", gecko: "radiant-capital",   stooq: "" },
    "MUBI-USD": { kraken: "",        binance: "MUBIUSDT", gecko: "multibit",          stooq: "" },
    "BIGTIME-USD":{ kraken: "",      binance: "BIGTIMEUSDT",gecko: "big-time",       stooq: "" },
    "NTRN-USD": { kraken: "",        binance: "NTRNUSDT", gecko: "neutron-3",         stooq: "" },
    "SXP-USD":  { kraken: "SXPUSD",  binance: "SXPUSDT",  gecko: "swipe",             stooq: "" },
    "TRB-USD":  { kraken: "TRBUSD",  binance: "TRBUSDT",  gecko: "tellor",            stooq: "" },
    "UMA-USD":  { kraken: "UMAUSD",  binance: "UMAUSDT",  gecko: "uma",               stooq: "" },
    "API3-USD": { kraken: "",        binance: "API3USDT", gecko: "api3",              stooq: "" },
    "BAND-USD": { kraken: "BANDUSD", binance: "BANDUSDT", gecko: "band-protocol",     stooq: "" },
    "CTSI-USD": { kraken: "",        binance: "CTSIUSDT", gecko: "cartesi",           stooq: "" },
    "NMR-USD":  { kraken: "NMRUSD",  binance: "NMRUSDT",  gecko: "numeraire",         stooq: "" },
    "REQ-USD":  { kraken: "",        binance: "REQUSDT",  gecko: "request-network",   stooq: "" },
    "POWR-USD": { kraken: "",        binance: "POWRUSDT", gecko: "power-ledger",      stooq: "" },
    "RLC-USD":  { kraken: "",        binance: "RLCUSDT",  gecko: "iexec-rlc",         stooq: "" },
    "OGN-USD":  { kraken: "",        binance: "OGNUSDT",  gecko: "origin-protocol",   stooq: "" },
    "SNT-USD":  { kraken: "",        binance: "SNTUSDT",  gecko: "status",            stooq: "" },
    "MLN-USD":  { kraken: "",        binance: "MLNUSDT",  gecko: "enzyme",            stooq: "" },
    "KEEP-USD": { kraken: "",        binance: "KEEPUSDT", gecko: "keep-network",      stooq: "" },
    "TBTC-USD": { kraken: "",        binance: "TBTCUSDT", gecko: "tbtc",              stooq: "" },
    "WAXL-USD": { kraken: "",        binance: "WAXLUSDT", gecko: "axelar",            stooq: "" },
    "OSMO-USD": { kraken: "OSMOUSD", binance: "OSMOUSDT", gecko: "osmosis",           stooq: "" },
    "JUNO-USD": { kraken: "JUNOUSD", binance: "JUNOUSDT", gecko: "juno-network",      stooq: "" },
    "AKT-USD":  { kraken: "",        binance: "AKTUSDT",  gecko: "akash-network",     stooq: "" },
    "SCRT-USD": { kraken: "",        binance: "SCRTUSDT", gecko: "secret",            stooq: "" },
    "DVPN-USD": { kraken: "",        binance: "DVPNUSDT", gecko: "sentinel",          stooq: "" },
    "IRIS-USD": { kraken: "",        binance: "IRISUSDT", gecko: "iris-network",      stooq: "" },
    "CTK-USD":  { kraken: "",        binance: "CTKUSDT",  gecko: "certik",            stooq: "" },
    "STRAX-USD":{ kraken: "",        binance: "STRAXUSDT",gecko: "stratis",           stooq: "" },
    "PUNDIX-USD":{ kraken: "",       binance: "PUNDIXUSDT",gecko: "pundi-x-2",        stooq: "" },
    "FXS-USD":  { kraken: "",        binance: "FXSUSDT",  gecko: "frax-share",        stooq: "" },
    "FRAX-USD": { kraken: "",        binance: "FRAXUSDT", gecko: "frax",              stooq: "" },
    "CFG-USD":  { kraken: "",        binance: "CFGUSDT",  gecko: "centrifuge",        stooq: "" },
    "POLYX-USD":{ kraken: "",        binance: "POLYXUSDT",gecko: "polymesh",          stooq: "" },
    "NODL-USD": { kraken: "",        binance: "NODLUSDT", gecko: "nodle-network",     stooq: "" },
    "ACH-USD":  { kraken: "",        binance: "ACHUSDT",  gecko: "alchemy-pay",       stooq: "" },
    "KEY-USD":  { kraken: "",        binance: "KEYUSDT",  gecko: "selfkey",           stooq: "" },
    "DENT-USD": { kraken: "",        binance: "DENTUSDT", gecko: "dent",              stooq: "" },
    "HOT-USD":  { kraken: "",        binance: "HOTUSDT",  gecko: "holotoken",         stooq: "" },
    "COTI-USD": { kraken: "",        binance: "COTIUSDT", gecko: "coti",              stooq: "" },
    "DUSK-USD": { kraken: "",        binance: "DUSKUSDT", gecko: "dusk-network",      stooq: "" },
    "OXT-USD":  { kraken: "",        binance: "OXTUSDT",  gecko: "orchid-protocol",   stooq: "" },
    "RARI-USD": { kraken: "",        binance: "RARIUSDT", gecko: "rarible",           stooq: "" },
    "SUPER-USD":{ kraken: "",        binance: "SUPERUSDT",gecko: "superfarm",         stooq: "" },
    "TRIBE-USD":{ kraken: "",        binance: "TRIBEUSDT",gecko: "tribe-2",           stooq: "" },
    "TRU-USD":  { kraken: "",        binance: "TRUUSDT",  gecko: "truefi",            stooq: "" },
    "TVK-USD":  { kraken: "",        binance: "TVKUSDT",  gecko: "the-virtua-kolect", stooq: "" },
    "UNFI-USD": { kraken: "",        binance: "UNFIUSDT", gecko: "unifi-protocol-dao",stooq: "" },
    "VANRY-USD":{ kraken: "",        binance: "VANRYUSDT",gecko: "vanar-chain",       stooq: "" },
    "VTHO-USD": { kraken: "",        binance: "VTHOUSDT", gecko: "vethor-token",      stooq: "" },
    "WOO-USD":  { kraken: "WOOUSD",  binance: "WOOUSDT",  gecko: "woo-network",       stooq: "" },
    "XAI-USD":  { kraken: "",        binance: "XAIUSDT",  gecko: "xai-blockchain",    stooq: "" },
    "XEC-USD":  { kraken: "",        binance: "XECUSDT",  gecko: "ecash",             stooq: "" },
    "XNO-USD":  { kraken: "XNOUSD",  binance: "XNOUSDT",  gecko: "nano",              stooq: "" },
    "YGG-USD":  { kraken: "",        binance: "YGGUSDT",  gecko: "yield-guild-games", stooq: "" },
    "ZEN-USD":  { kraken: "ZENUSD",  binance: "ZENUSDT",  gecko: "zencash",           stooq: "" },
    "AMP-USD":  { kraken: "",        binance: "AMPUSDT",  gecko: "amp-token",         stooq: "" },
    "ANT-USD":  { kraken: "",        binance: "ANTUSDT",  gecko: "aragon",            stooq: "" },
    "ARPA-USD": { kraken: "",        binance: "ARPAUSDT", gecko: "arpa",              stooq: "" },
    "AUDIO-USD":{ kraken: "",        binance: "AUDIOUSDT",gecko: "audius",            stooq: "" },
    "BADGER-USD":{ kraken: "",       binance: "BADGERUSDT",gecko: "badger-dao",       stooq: "" },
    "BLZ-USD":  { kraken: "",        binance: "BLZUSDT",  gecko: "bluzelle",          stooq: "" },
    "BNT-USD":  { kraken: "",        binance: "BNTUSDT",  gecko: "bancor",            stooq: "" },
    "CELR-USD": { kraken: "",        binance: "CELRUSDT", gecko: "celer-network",     stooq: "" },
    "CHR-USD":  { kraken: "",        binance: "CHRUSDT",  gecko: "chromia",           stooq: "" },
    "COCOS-USD":{ kraken: "",        binance: "COCOSUSDT",gecko: "cocos-bcx",         stooq: "" },
    "CQT-USD":  { kraken: "",        binance: "CQTUSDT",  gecko: "covalent",          stooq: "" },
    "CTXC-USD": { kraken: "",        binance: "CTXCUSDT", gecko: "cortex",            stooq: "" },
    "DATA-USD": { kraken: "",        binance: "DATAUSDT", gecko: "streamr",           stooq: "" },
    "DCR-USD":  { kraken: "DCRUSD",  binance: "DCRUSDT",  gecko: "decred",            stooq: "" },
    "DIA-USD":  { kraken: "",        binance: "DIAUSDT",  gecko: "dia-data",          stooq: "" },
    "DOCK-USD": { kraken: "",        binance: "DOCKUSDT", gecko: "dock",              stooq: "" },
    "DODO-USD": { kraken: "",        binance: "DODOUSDT", gecko: "dodo",              stooq: "" },
    "DREP-USD": { kraken: "",        binance: "DREPUSDT", gecko: "drep-new",          stooq: "" },
    "ELF-USD":  { kraken: "",        binance: "ELFUSDT",  gecko: "aelf",              stooq: "" },
    "ENG-USD":  { kraken: "",        binance: "ENGUSDT",  gecko: "enigma",            stooq: "" },
    "FIDA-USD": { kraken: "FIDAUSD", binance: "FIDAUSDT", gecko: "bonfida",           stooq: "" },
    "FLM-USD":  { kraken: "",        binance: "FLMUSDT",  gecko: "flamingo",          stooq: "" },
    "FORTH-USD":{ kraken: "FORTHUSD",binance: "FORTHUSDT",gecko: "ampleforth-governance-token", stooq: "" },
    "FRONT-USD":{ kraken: "",        binance: "FRONTUSDT",gecko: "frontier-token",    stooq: "" },
    "FTT-USD":  { kraken: "FTTUSD",  binance: "FTTUSDT",  gecko: "ftx-token",         stooq: "" },
    "GAS-USD":  { kraken: "",        binance: "GASUSDT",  gecko: "gas",               stooq: "" },
    "GLM-USD":  { kraken: "",        binance: "GLMUSDT",  gecko: "golem",             stooq: "" },
    "HIVE-USD": { kraken: "",        binance: "HIVEUSDT", gecko: "hive",              stooq: "" },
    "ICX-USD":  { kraken: "ICXUSD",  binance: "ICXUSDT",  gecko: "icon",              stooq: "" },
    "ILV-USD":  { kraken: "",        binance: "ILVUSDT",  gecko: "illuvium",          stooq: "" },
    "IOST-USD": { kraken: "",        binance: "IOSTUSDT", gecko: "iostoken",          stooq: "" },
    "JASMY-USD":{ kraken: "",        binance: "JASMYUSDT",gecko: "jasmycoin",         stooq: "" },
    "LIT-USD":  { kraken: "",        binance: "LITUSDT",  gecko: "litentry",          stooq: "" },
    "LOOM-USD": { kraken: "",        binance: "LOOMUSDT", gecko: "loom-network-new",  stooq: "" },
    "LPT-USD":  { kraken: "",        binance: "LPTUSDT",  gecko: "livepeer",          stooq: "" },
    "MBOX-USD": { kraken: "",        binance: "MBOXUSDT", gecko: "mobox",             stooq: "" },
    "NKN-USD":  { kraken: "",        binance: "NKNUSDT",  gecko: "nkn",               stooq: "" },
    "OG-USD":   { kraken: "",        binance: "OGUSDT",   gecko: "og-fan-token",      stooq: "" },
    "ONT-USD":  { kraken: "ONTUSD",  binance: "ONTUSDT",  gecko: "ontology",          stooq: "" },
    "PAXG-USD": { kraken: "PAXGUSD", binance: "PAXGUSDT", gecko: "pax-gold",          stooq: "" },
    "PERP-USD": { kraken: "",        binance: "PERPUSDT", gecko: "perpetual-protocol",stooq: "" },
    "POLS-USD": { kraken: "",        binance: "POLSUSDT", gecko: "polkastarter",      stooq: "" },
    "POLY-USD": { kraken: "",        binance: "POLYUSDT", gecko: "polymath",          stooq: "" },
    "POND-USD": { kraken: "",        binance: "PONDUSDT", gecko: "marlin",            stooq: "" },
    "PROM-USD": { kraken: "",        binance: "PROMUSDT", gecko: "prometeus",         stooq: "" },
    "QKC-USD":  { kraken: "",        binance: "QKCUSDT",  gecko: "quark-chain",       stooq: "" },
    "RAD-USD":  { kraken: "",        binance: "RADUSDT",  gecko: "radicle",           stooq: "" },
    "RARE-USD": { kraken: "",        binance: "RAREUSDT", gecko: "superrare",         stooq: "" },
    "REP-USD":  { kraken: "REPUSD",  binance: "REPUSDT",  gecko: "augur",             stooq: "" },
    "RIF-USD":  { kraken: "",        binance: "RIFUSDT",  gecko: "rif-token",         stooq: "" },
    "RSR-USD":  { kraken: "",        binance: "RSRUSDT",  gecko: "reserve-rights-token", stooq: "" },
    "RUNE-USD": { kraken: "RUNEUSD", binance: "RUNEUSDT", gecko: "thorchain",         stooq: "" },
    "SFP-USD":  { kraken: "",        binance: "SFPUSDT",  gecko: "safepal",           stooq: "" },
    "SKL-USD":  { kraken: "",        binance: "SKLUSDT",  gecko: "skale",             stooq: "" },
    "SLP-USD":  { kraken: "",        binance: "SLPUSDT",  gecko: "smooth-love-potion",stooq: "" },
    "SRM-USD":  { kraken: "",        binance: "SRMUSDT",  gecko: "serum",             stooq: "" },
    "STMX-USD": { kraken: "",        binance: "STMXUSDT", gecko: "storm",             stooq: "" },
    "TFUEL-USD":{ kraken: "",        binance: "TFUELUSDT",gecko: "theta-fuel",        stooq: "" },
    "TWT-USD":  { kraken: "",        binance: "TWTUSDT",  gecko: "trust-wallet-token",stooq: "" },
    "WAN-USD":  { kraken: "",        binance: "WANUSDT",  gecko: "wanchain",          stooq: "" },
    "WNXM-USD": { kraken: "",        binance: "WNXMUSDT", gecko: "wrapped-nxm",       stooq: "" },
    "WRX-USD":  { kraken: "",        binance: "WRXUSDT",  gecko: "wazirx",            stooq: "" },
    "XEM-USD":  { kraken: "",        binance: "XEMUSDT",  gecko: "nem",               stooq: "" },
    "XVG-USD":  { kraken: "",        binance: "XVGUSDT",  gecko: "verge",             stooq: "" },
    "XVS-USD":  { kraken: "",        binance: "XVSUSDT",  gecko: "venus",             stooq: "" },
    "YFII-USD": { kraken: "",        binance: "YFIIUSDT", gecko: "yfii-finance",      stooq: "" },
};

// ============================================================================
// FUTURES MAP — verbatim from ÆEA-era worker.js
// ============================================================================
const FUTURES_MAP = {
    "GC=F": { stooq: "gc.f", yahoo: "GC=F" },
    "SI=F": { stooq: "si.f", yahoo: "SI=F" },
    "HG=F": { stooq: "hg.f", yahoo: "HG=F" },
    "PL=F": { stooq: "pl.f", yahoo: "PL=F" },
    "PA=F": { stooq: "pa.f", yahoo: "PA=F" },
    "ALI=F":{ stooq: "ali.f",yahoo: "ALI=F" },
    "CL=F": { stooq: "cl.f", yahoo: "CL=F" },
    "NG=F": { stooq: "ng.f", yahoo: "NG=F" },
    "RB=F": { stooq: "rb.f", yahoo: "RB=F" },
    "HO=F": { stooq: "ho.f", yahoo: "HO=F" },
    "BZ=F": { stooq: "bz.f", yahoo: "BZ=F" },
    "QM=F": { stooq: "qm.f", yahoo: "QM=F" },
    "QA=F": { stooq: "qa.f", yahoo: "QA=F" },
    "ZS=F": { stooq: "zs.f", yahoo: "ZS=F" },
    "ZM=F": { stooq: "zm.f", yahoo: "ZM=F" },
    "ZW=F": { stooq: "zw.f", yahoo: "ZW=F" },
    "KE=F": { stooq: "ke.f", yahoo: "KE=F" },
    "ZC=F": { stooq: "zc.f", yahoo: "ZC=F" },
    "ZL=F": { stooq: "zl.f", yahoo: "ZL=F" },
    "ZR=F": { stooq: "zr.f", yahoo: "ZR=F" },
    "ZO=F": { stooq: "zo.f", yahoo: "ZO=F" },
    "ZP=F": { stooq: "zp.f", yahoo: "ZP=F" },
    "CC=F": { stooq: "cc.f", yahoo: "CC=F" },
    "KC=F": { stooq: "kc.f", yahoo: "KC=F" },
    "SB=F": { stooq: "sb.f", yahoo: "SB=F" },
    "CT=F": { stooq: "ct.f", yahoo: "CT=F" },
    "OJ=F": { stooq: "oj.f", yahoo: "OJ=F" },
    "LBS=F":{ stooq: "lbs.f",yahoo: "LBS=F" },
    "LE=F": { stooq: "le.f", yahoo: "LE=F" },
    "GF=F": { stooq: "gf.f", yahoo: "GF=F" },
    "HE=F": { stooq: "he.f", yahoo: "HE=F" },
    "LH=F": { stooq: "lh.f", yahoo: "LH=F" },
    "ZB=F": { stooq: "zb.f", yahoo: "ZB=F" },
    "ZN=F": { stooq: "zn.f", yahoo: "ZN=F" },
    "ZF=F": { stooq: "zf.f", yahoo: "ZF=F" },
    "ZT=F": { stooq: "zt.f", yahoo: "ZT=F" },
    "ZQ=F": { stooq: "zq.f", yahoo: "ZQ=F" },
    "GE=F": { stooq: "ge.f", yahoo: "GE=F" },
    "SR3=F":{ stooq: "sr3.f",yahoo: "SR3=F" },
    "TN=F": { stooq: "tn.f", yahoo: "TN=F" },
    "ES=F": { stooq: "es.f", yahoo: "ES=F" },
    "NQ=F": { stooq: "nq.f", yahoo: "NQ=F" },
    "YM=F": { stooq: "ym.f", yahoo: "YM=F" },
    "RTY=F":{ stooq: "rty.f",yahoo: "RTY=F" },
    "NKD=F":{ stooq: "nkd.f",yahoo: "NKD=F" },
    "VX=F": { stooq: "vx.f", yahoo: "VX=F" },
    "MES=F":{ stooq: "mes.f",yahoo: "MES=F" },
    "MNQ=F":{ stooq: "mnq.f",yahoo: "MNQ=F" },
    "MYM=F":{ stooq: "mym.f",yahoo: "MYM=F" },
    "M2K=F":{ stooq: "m2k.f",yahoo: "M2K=F" },
    "BTC=F":{ stooq: "btc.f",yahoo: "BTC=F" },
    "ETH=F":{ stooq: "eth.f",yahoo: "ETH=F" },
    "MBT=F":{ stooq: "mbt.f",yahoo: "MBT=F" },
    "MET=F":{ stooq: "met.f",yahoo: "MET=F" },
    "DX=F": { stooq: "dx.f", yahoo: "DX=F" },
    "6E=F": { stooq: "6e.f", yahoo: "6E=F" },
    "6J=F": { stooq: "6j.f", yahoo: "6J=F" },
    "6B=F": { stooq: "6b.f", yahoo: "6B=F" },
    "6A=F": { stooq: "6a.f", yahoo: "6A=F" },
    "6C=F": { stooq: "6c.f", yahoo: "6C=F" },
    "6S=F": { stooq: "6s.f", yahoo: "6S=F" },
    "6N=F": { stooq: "6n.f", yahoo: "6N=F" },
    "6M=F": { stooq: "6m.f", yahoo: "6M=F" },
    "6Z=F": { stooq: "6z.f", yahoo: "6Z=F" },
    "AD=F": { stooq: "ad.f", yahoo: "AD=F" },
    "CD=F": { stooq: "cd.f", yahoo: "CD=F" },
    "NE=F": { stooq: "ne.f", yahoo: "NE=F" },
    "SS=F": { stooq: "ss.f", yahoo: "SS=F" },
    "NI=F": { stooq: "ni.f", yahoo: "NI=F" },
    "PB=F": { stooq: "pb.f", yahoo: "PB=F" },
    "SN=F": { stooq: "sn.f", yahoo: "SN=F" },
};

// ============================================================================
// EQUITIES MAP — hyphen-preserving class-share format
// ============================================================================
const EQUITIES_MAP = (() => {
    const tickers = [
        "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA",
        "AVGO", "ORCL", "CRM", "ADBE", "AMD", "INTC", "CSCO", "QCOM",
        "TXN", "MU", "AMAT", "LRCX", "KLAC", "MRVL", "SNPS", "CDNS",
        "INTU", "NOW", "PANW", "CRWD", "ZS", "DDOG", "SNOW", "PLTR",
        "AI", "SMCI", "ARM", "DELL", "HPQ", "HPE", "WDC", "STX",
        "IBM", "ACN", "UBER", "LYFT", "ABNB", "DASH", "SHOP", "SQ",
        "PYPL", "COIN", "HOOD", "SOFI", "AFRM", "UPST", "LC",
        "NFLX", "DIS", "CMCSA", "T", "VZ", "TMUS", "WBD", "PARA",
        "SPOT", "RBLX", "U", "EA", "TTWO", "ATVI", "NTES", "BIDU",
        "JD", "PDD", "BABA", "TCEHY", "NTDOY", "SONY",
        "WMT", "COST", "TGT", "HD", "LOW", "NKE", "SBUX", "MCD",
        "KO", "PEP", "PG", "CL", "KMB", "GIS", "K", "HSY",
        "MDLZ", "STZ", "TAP", "SAM", "BUD", "DEO", "MO", "PM",
        "EL", "ULTA", "ROST", "TJX", "BBY", "DG", "DLTR",
        "LULU", "GPS", "ANF", "M", "KSS", "JWN",
        "JPM", "BAC", "WFC", "C", "GS", "MS", "BLK", "SCHW",
        "AXP", "V", "MA", "USB", "PNC", "TFC", "COF", "DFS",
        "BK", "STT", "NTRS", "FITB", "HBAN", "RF", "KEY", "CFG",
        "BRK-B", "BRK-A", "AIG", "MET", "PRU", "AFL", "ALL", "TRV",
        "PGR", "CB", "MMC", "AON", "AJG", "WLTW", "BRO",
        "JNJ", "PFE", "MRK", "ABBV", "LLY", "BMY", "AMGN", "GILD",
        "BIIB", "REGN", "VRTX", "MRNA", "BNTX", "AZN", "GSK", "SNY",
        "NVS", "UNH", "CVS", "CI", "HUM", "ELV", "ANTM", "CNC",
        "MOH", "HCA", "UHS", "THC", "MCK", "ABC", "CAH",
        "MDT", "SYK", "BSX", "ZBH", "BDX", "BAX", "ISRG", "EW",
        "DXCM", "PODD", "ILMN", "CRL", "IQV", "A", "WAT", "MTD",
        "BA", "CAT", "DE", "HON", "GE", "MMM", "LMT", "RTX",
        "NOC", "GD", "LHX", "HII", "TDG", "HWM", "TXT", "CARR",
        "OTIS", "CMI", "PCAR", "NAV", "URI", "FAST", "GWW", "ITW",
        "EMR", "ETN", "PH", "ROK", "DOV", "AME", "IR", "XYL",
        "UPS", "FDX", "DAL", "UAL", "AAL", "LUV", "ALK", "JBLU",
        "XOM", "CVX", "COP", "EOG", "PXD", "OXY", "PSX", "VLO",
        "MPC", "SLB", "HAL", "BKR", "NOV", "FTI", "KMI", "WMB",
        "OKE", "ET", "EPD", "MMP", "PAA", "TRGP", "LNG", "EQT",
        "RRC", "AR", "CNX", "SWN", "CHK", "DVN", "FANG", "HES",
        "MRO", "APA", "CTRA",
        "LIN", "APD", "SHW", "ECL", "DD", "DOW", "LYB", "PPG",
        "NEM", "FCX", "NUE", "STLD", "CLF", "X", "AA", "MP",
        "ALB", "SQM", "LAC", "VALE", "RIO", "BHP", "MT", "GOLD",
        "NEE", "DUK", "SO", "D", "AEP", "EXC", "XEL", "ED",
        "WEC", "ES", "AWK", "SRE", "PCG", "EIX", "PEG", "FE",
        "PPL", "CMS", "DTE", "AEE", "CNP", "NI", "LNT", "EVRG",
        "PLD", "AMT", "CCI", "EQIX", "DLR", "SPG", "O", "PSA",
        "EXR", "AVB", "EQR", "MAA", "ESS", "UDR", "CPT", "AIV",
        "VTR", "WELL", "PEAK", "HST", "RHP", "IRM", "SBAC",
        "SPY", "QQQ", "DIA", "IWM", "VTI", "VOO", "VEA", "VWO",
        "IVV", "VTV", "VUG", "IWF", "IWD", "IWB", "IWV", "RSP",
        "MDY", "IJH", "IJR", "IJS", "IJJ", "IJK", "IJT",
        "XLK", "XLF", "XLV", "XLE", "XLI", "XLP", "XLY", "XLU",
        "XLB", "XLRE", "XLC", "SMH", "SOXX", "IGV", "VGT", "FTEC",
        "VHT", "VFH", "VIS", "VPU", "VDC", "VCR", "VAW", "VNQ",
        "KRE", "KBE", "XBI", "IBB", "IHI", "IHF", "ITA", "XAR",
        "XOP", "OIH", "XME", "GDX", "GDXJ", "SIL", "URA", "LIT",
        "TAN", "ICLN", "PBW", "FAN", "JETS", "PEJ", "XRT", "ITB",
        "XHB", "HACK", "BOTZ", "ROBO", "ARKK", "ARKG", "ARKW",
        "ARKF", "ARKQ", "ARKX",
        "EFA", "EEM", "IEFA", "IEMG", "FXI", "MCHI", "KWEB", "CQQQ",
        "EWJ", "EWZ", "EWW", "EWY", "EWT", "EWU", "EWG", "EWQ",
        "EWI", "EWP", "EWN", "EWD", "EWL", "EWC", "EWA", "EWH",
        "EWS", "EWM", "EPI", "INDA", "SMIN", "EPHE", "EZA", "TUR",
        "EIS", "KSA", "UAE",
        "GLD", "IAU", "SLV", "SIVR", "PPLT", "PALL", "USO", "BNO",
        "UNG", "UNL", "DBA", "DBC", "GSG", "PDBC", "CPER", "COPX",
        "REMX", "WOOD",
        "TLT", "IEF", "SHY", "AGG", "BND", "LQD", "HYG", "JNK",
        "TIP", "VTIP", "MUB", "EMB", "BNDX", "IGSB", "IGIB",
        "SCHO", "SCHR", "SCHZ", "VCIT", "VCSH", "BSV", "BIV",
        "BLV", "GOVT", "SPTL", "SPTI", "SPTS",
        "TQQQ", "SQQQ", "SPXL", "SPXS", "UPRO", "SPXU", "TNA",
        "TZA", "FAS", "FAZ", "LABU", "LABD", "YINN", "YANG",
        "SOXL", "SOXS", "TECL", "TECS", "UDOW", "SDOW",
        "SCHD", "VYM", "DVY", "HDV", "SPHD", "SDY", "VIG", "DGRO",
        "NOBL", "QUAL", "MTUM", "VLUE", "SIZE", "USMV", "SPLV",
        "SPHQ", "RPG", "RPV", "EQWL",
        "QCLN", "ACES", "DRIV", "IDRV", "ESPO", "NERD", "HERO", "GAMR",
        "BITO", "BITQ", "WGMI", "DAPP", "BLOK", "LEGR", "MOAT",
        "SCHG", "SCHV", "VONG", "VONV", "IUSG", "IUSV",
        "RIVN", "LCID", "NIO", "XPEV", "LI", "FSR", "GOEV",
        "PLUG", "FCEL", "BLDP", "BE", "ENPH", "SEDG", "RUN",
        "NOVA", "SPWR", "CSIQ", "JKS", "DQ", "MAXN", "ARRY",
        "MSTR", "MARA", "RIOT", "HUT", "BITF", "CLSK", "CIFR",
        "IREN", "WULF", "CORZ", "BTBT", "CAN", "EBON", "SOS",
        "GME", "AMC", "BB", "NOK", "KOSS", "EXPR", "BBBY",
        "CVNA", "CHWY", "W", "ETSY", "EBAY", "OSTK", "WISH",
        "PTON", "ZM", "DOCU", "TWLO", "OKTA", "NET",
        "FSLY", "ESTC", "MDB", "TEAM", "WORK", "SPLK", "NEWR",
        "SUMO", "PD", "APPF", "BL", "ZI", "MGNI", "TTD", "PUBM",
        "ROKU", "FUBO", "ASAN", "MNDY",
        "HUBS", "BILL", "TOST",
    ];
    const map = {};
    for (const t of tickers) {
        const stooqTicker = t.toLowerCase();
        map[t] = { stooq: stooqTicker + ".us", yahoo: t };
    }
    return map;
})();

// ============================================================================
// FOREX MAP — Yahoo only
// ============================================================================
const FOREX_MAP = (() => {
    const pairs = [
        "EURUSD=X", "GBPUSD=X", "USDJPY=X", "USDCHF=X", "USDCAD=X",
        "AUDUSD=X", "NZDUSD=X", "EURGBP=X", "EURJPY=X", "EURCHF=X",
        "EURCAD=X", "EURAUD=X", "EURNZD=X", "GBPJPY=X", "GBPCHF=X",
        "GBPCAD=X", "GBPAUD=X", "GBPNZD=X", "AUDJPY=X", "AUDCHF=X",
        "AUDCAD=X", "AUDNZD=X", "NZDJPY=X", "NZDCHF=X", "NZDCAD=X",
        "CADJPY=X", "CADCHF=X", "CHFJPY=X", "USDSEK=X", "USDNOK=X",
        "USDDKK=X", "USDPLN=X", "USDHUF=X", "USDCZK=X", "USDTRY=X",
        "USDMXN=X", "USDZAR=X", "USDSGD=X", "USDHKD=X", "USDCNH=X",
        "USDINR=X", "USDKRW=X", "USDTWD=X", "USDTHB=X", "USDMYR=X",
        "USDPHP=X", "USDIDR=X", "USDBRL=X", "USDARS=X", "USDCLP=X",
    ];
    const map = {};
    for (const p of pairs) {
        map[p] = { yahoo: p };
        const short = p.replace("=X", "");
        if (!map[short]) map[short] = { yahoo: p };
    }
    return map;
})();

// ============================================================================
// INDICES MAP — Yahoo only
// ============================================================================
const INDICES_MAP = {
    "^GSPC":  { yahoo: "^GSPC" },
    "^DJI":   { yahoo: "^DJI" },
    "^IXIC":  { yahoo: "^IXIC" },
    "^RUT":   { yahoo: "^RUT" },
    "^VIX":   { yahoo: "^VIX" },
    "^FTSE":  { yahoo: "^FTSE" },
    "^GDAXI": { yahoo: "^GDAXI" },
    "^FCHI":  { yahoo: "^FCHI" },
    "^STOXX50E": { yahoo: "^STOXX50E" },
    "^N225":  { yahoo: "^N225" },
    "^HSI":   { yahoo: "^HSI" },
    "^KS11":  { yahoo: "^KS11" },
    "^AXJO":  { yahoo: "^AXJO" },
    "^BSESN": { yahoo: "^BSESN" },
    "^BVSP":  { yahoo: "^BVSP" },
    "^MXX":   { yahoo: "^MXX" },
    "^TWII":  { yahoo: "^TWII" },
    "^STI":   { yahoo: "^STI" },
};

// ============================================================================
// HELPERS — shared
// ============================================================================
function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept, X-Relay-Key",
        "Access-Control-Max-Age": "86400",
    };
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...corsHeaders(),
        },
    });
}

// ============================================================================
// HELPERS — crawler
// ============================================================================
function isPrivateIp(hostname) {
    if (!hostname) return true;
    const h = hostname.toLowerCase();
    for (const sub of BLOCKED_HOST_SUBSTRINGS) {
        if (h.includes(sub)) return true;
    }
    for (const pref of BLOCKED_PRIVATE_PREFIXES) {
        if (h.startsWith(pref)) return true;
    }
    if (h.startsWith("172.")) {
        const second = parseInt(h.split(".")[1] || "0", 10);
        if (second >= 16 && second <= 31) return true;
    }
    return false;
}

function isValidHttpUrl(u) {
    try {
        const parsed = new URL(u);
        if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) return false;
        if (isPrivateIp(parsed.hostname)) return false;
        return true;
    } catch (e) {
        return false;
    }
}

async function sha256Hex(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
}

function htmlToText(html) {
    if (!html) return "";
    let s = html;
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
    s = s.replace(/<[^>]+>/g, " ");
    s = decodeEntities(s);
    s = s.replace(/\s+/g, " ").trim();
    return s;
}

function extractTitle(html, fallbackUrl, precomputedText) {
    if (!html) return fallbackUrl;
    let m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m && m[1]) {
        let inner = m[1].replace(/<[^>]+>/g, " ");
        inner = decodeEntities(inner);
        const t = inner.replace(/\s+/g, " ").trim();
        if (t) return t.slice(0, 200);
    }
    m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (m && m[1]) {
        let inner = m[1].replace(/<[^>]+>/g, " ");
        inner = decodeEntities(inner);
        const t = inner.replace(/\s+/g, " ").trim();
        if (t) return t.slice(0, 200);
    }
    const text = precomputedText || htmlToText(html);
    for (const line of text.split(/\n+/)) {
        const t = line.trim();
        if (t.length >= 3) return t.slice(0, 200);
    }
    return fallbackUrl;
}

function decodeEntities(s) {
    if (!s) return "";
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&mdash;/g, "—")
        .replace(/&ndash;/g, "–")
        .replace(/&hellip;/g, "…")
        .replace(/&copy;/g, "©")
        .replace(/&#(\d+);/g, (_, n) => {
            try { return String.fromCharCode(parseInt(n, 10)); } catch { return ""; }
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
            try { return String.fromCharCode(parseInt(h, 16)); } catch { return ""; }
        });
}

function extractLinks(html, baseUrl) {
    if (!html) return [];
    const links = [];
    const seen = new Set();
    const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let m;
    while ((m = re.exec(html)) !== null && links.length < MAX_LINKS) {
        const href = (m[1] || m[2] || m[3] || "").trim();
        if (!href) continue;
        if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
        try {
            const abs = new URL(href, baseUrl).toString();
            if (!isValidHttpUrl(abs)) continue;
            if (seen.has(abs)) continue;
            seen.add(abs);
            links.push(abs);
        } catch (e) {}
    }
    return links;
}

async function readBoundedBody(resp) {
    const reader = resp.body ? resp.body.getReader() : null;
    if (!reader) {
        const text = await resp.text();
        return text.slice(0, MAX_HTML_BYTES);
    }
    let received = 0;
    const chunks = [];
    const decoder = new TextDecoder();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (received > MAX_HTML_BYTES) {
                const remaining = MAX_HTML_BYTES - (received - value.length);
                if (remaining > 0) chunks.push(decoder.decode(value.slice(0, remaining), { stream: true }));
                break;
            }
            chunks.push(decoder.decode(value, { stream: true }));
        }
    } finally {
        try { reader.releaseLock(); } catch {}
    }
    chunks.push(decoder.decode());
    return chunks.join("");
}

async function fetchCrawlerOne(url) {
    const startedAt = Date.now();
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const resp = await fetch(url, {
                method: "GET",
                headers: { "User-Agent": UA_CRAWLER, "Accept": "text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.8" },
                signal: controller.signal,
                redirect: "follow",
            });
            clearTimeout(timeout);
            if (resp.status === 429) {
                const retryAfter = parseInt(resp.headers.get("retry-after") || "2", 10) * 1000;
                await new Promise(r => setTimeout(r, Math.min(retryAfter, 5000) + 400));
                continue;
            }
            const status = resp.status;
            if (!resp.ok) {
                return {
                    ok: false,
                    url,
                    error: "http_" + status,
                    status,
                    elapsed_ms: Date.now() - startedAt,
                };
            }
            const contentType = (resp.headers.get("content-type") || "").toLowerCase();
            if (contentType && !contentType.includes("html") && !contentType.includes("xml") && !contentType.includes("text")) {
                return {
                    ok: true,
                    url,
                    title: url,
                    content_hash: "00000000000000000000000000000001",
                    links: [],
                    text_length: 0,
                    fetched_at: new Date().toISOString(),
                    provider: "crawler-relay",
                    status,
                    content_type: contentType,
                    elapsed_ms: Date.now() - startedAt,
                };
            }
            const html = await readBoundedBody(resp);
            const textContent = htmlToText(html);
            const title = extractTitle(html, url, textContent);
            const content_hash = textContent ? await sha256Hex(textContent) : "00000000000000000000000000000001";
            const links = extractLinks(html, url);
            const result = {
                ok: true,
                url,
                title,
                content_hash,
                links,
                text_length: textContent.length,
                fetched_at: new Date().toISOString(),
                provider: "crawler-relay",
                status,
                content_type: contentType,
                elapsed_ms: Date.now() - startedAt,
                attempts: attempt + 1,
            };
            try {
                const cache = caches.default;
                const cacheKey = new Request("https://ae-fused-relay-cache/" + encodeURIComponent(url), { method: "GET" });
                const cacheResp = new Response(JSON.stringify(result), {
                    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }
                });
                await cache.put(cacheKey, cacheResp);
            } catch (e) {}
            return result;
        } catch (e) {
            clearTimeout(timeout);
            const elapsed = Date.now() - startedAt;
            const msg = String(e && e.message ? e.message : e);
            const isTimeout = (e && (e.name === "AbortError" || /timeout/i.test(msg)));
            const isRetryable = /UNEXPECTED_EOF|EOF|525|502|reset|ECONNRESET/i.test(msg) || isTimeout;
            lastErr = e;
            if (isRetryable && attempt < 2) {
                const backoff = 500 * (attempt + 1) + Math.random() * 400;
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            return {
                ok: false,
                url,
                error: isTimeout ? "fetch_timeout" : "fetch_error",
                detail: msg,
                elapsed_ms: elapsed,
                status: 0,
                attempts: attempt + 1,
            };
        }
    }
    return {
        ok: false,
        url,
        error: "fetch_error_after_retry",
        detail: String(lastErr),
        elapsed_ms: Date.now() - startedAt,
        status: 0,
    };
}

// ============================================================================
// HELPERS — market: shared bar shaping
// ============================================================================
function shapeBar(quote, ts, i) {
    const num = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Number(v));
    const iso = ts && ts[i] ? new Date(ts[i] * 1000).toISOString() : new Date().toISOString();
    return {
        open: num(quote.open?.[i]),
        high: num(quote.high?.[i]),
        low: num(quote.low?.[i]),
        close: num(quote.close?.[i]),
        volume: num(quote.volume?.[i]),
        timestamp: iso,
    };
}

// ============================================================================
// PROVIDER — Kraken (crypto primary)
// ============================================================================
async function fetchKraken(symbol, kind, interval, limit) {
    const mapped = CRYPTO_MAP[symbol];
    if (!mapped || !mapped.kraken) throw new Error("kraken_symbol_not_mapped");
    const pair = mapped.kraken;
    const provider = "kraken";
    const intervalMap = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };
    const ki = intervalMap[interval] || 1;
    if (kind === "price" || kind === "volume") {
        const upstream = `${KRAKEN_HOST}/Ticker?pair=${encodeURIComponent(pair)}`;
        const response = await fetch(upstream, {
            headers: { "User-Agent": UA_MARKET, "Accept": "application/json" },
            cf: { cacheTtl: 5, cacheEverything: true },
        });
        if (!response.ok) throw new Error(`kraken_http_${response.status}`);
        const raw = await response.json();
        if (Array.isArray(raw.error) && raw.error.length > 0) {
            throw new Error(`kraken_error_${raw.error[0]}`);
        }
        const result = raw.result;
        if (!result) throw new Error("kraken_no_result");
        const keys = Object.keys(result);
        if (keys.length === 0) throw new Error("kraken_empty_result");
        const entry = result[keys[0]];
        if (!entry || !entry.c || !entry.c[0]) throw new Error("kraken_no_price");
        const last = Number(entry.c[0]);
        if (!isFinite(last) || last <= 0) throw new Error("kraken_invalid_price");
        if (kind === "volume") {
            const vol24 = entry.v ? Number(entry.v[1] || 0) : 0;
            return { symbol, volume: vol24, volume_24h: vol24, provider };
        }
        const bid = entry.b ? Number(entry.b[0]) : last;
        const ask = entry.a ? Number(entry.a[0]) : last;
        const vol24 = entry.v ? Number(entry.v[1] || 0) : 0;
        return {
            symbol,
            close: last,
            bid: isFinite(bid) && bid > 0 ? bid : last,
            ask: isFinite(ask) && ask > 0 ? ask : last,
            volume: vol24,
            timestamp: new Date().toISOString(),
            provider,
        };
    }
    if (kind === "intraday" || kind === "history" || kind === "candles") {
        const upstream = `${KRAKEN_HOST}/OHLC?pair=${encodeURIComponent(pair)}&interval=${ki}`;
        const response = await fetch(upstream, {
            headers: { "User-Agent": UA_MARKET, "Accept": "application/json" },
            cf: { cacheTtl: 15, cacheEverything: true },
        });
        if (!response.ok) throw new Error(`kraken_http_${response.status}`);
        const raw = await response.json();
        if (Array.isArray(raw.error) && raw.error.length > 0) {
            throw new Error(`kraken_error_${raw.error[0]}`);
        }
        const result = raw.result;
        if (!result) throw new Error("kraken_no_result");
        const keys = Object.keys(result).filter((k) => k !== "last");
        if (keys.length === 0) throw new Error("kraken_no_ohlc");
        const rows = result[keys[0]];
        if (!Array.isArray(rows) || rows.length === 0) throw new Error("kraken_no_rows");
        const bars = rows.map((r) => ({
            open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
            volume: Number(r[6]), timestamp: new Date(Number(r[0]) * 1000).toISOString(), provider,
        }));
        if (kind === "intraday") {
            const last = bars[bars.length - 1];
            return { symbol, ...last, provider };
        }
        const lim = Math.max(1, Math.min(1000, parseInt(limit || "200", 10) || 200));
        return bars.slice(-lim);
    }
    throw new Error("kraken_unknown_kind");
}

// ============================================================================
// PROVIDER — Stooq (equities/futures primary)
// ============================================================================
async function fetchStooq(symbol, kind, interval, limit) {
    const mapped = EQUITIES_MAP[symbol] || FUTURES_MAP[symbol];
    if (!mapped || !mapped.stooq) throw new Error("stooq_symbol_not_mapped");
    const stq = mapped.stooq;
    const provider = "stooq";
    if (kind === "price" || kind === "volume") {
        const upstream = `${STOOQ_HOST}?s=${encodeURIComponent(stq)}&f=sd2t2ohlcv&h&e=csv`;
        const response = await fetch(upstream, {
            headers: { "User-Agent": UA_MARKET, "Accept": "text/csv,text/plain,*/*" },
            cf: { cacheTtl: 5, cacheEverything: true },
        });
        if (!response.ok) throw new Error(`stooq_http_${response.status}`);
        const text = await response.text();
        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) throw new Error("stooq_no_data");
        const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
        const closeIdx = header.indexOf("close");
        const volIdx = header.indexOf("volume");
        if (closeIdx < 0) throw new Error("stooq_bad_header");
        const cols = lines[1].split(",");
        if (cols.length <= closeIdx) throw new Error("stooq_bad_columns");
        const num = (v) => {
            if (v === "N/D" || v === "" || v === undefined) return null;
            const n = Number(v);
            return isFinite(n) ? n : null;
        };
        const close = num(cols[closeIdx]);
        if (close === null || close <= 0) throw new Error("stooq_no_price");
        const volume = volIdx >= 0 && volIdx < cols.length ? num(cols[volIdx]) : null;
        if (kind === "volume") {
            return { symbol, volume: volume ?? 0, volume_24h: volume ?? 0, provider };
        }
        return {
            symbol, close, bid: close, ask: close,
            volume: volume ?? 0, timestamp: new Date().toISOString(), provider,
        };
    }
    if (kind === "intraday" || kind === "history" || kind === "candles") {
        const endpoint = (kind === "intraday") ? "a" : "d";
        const fields = (kind === "intraday") ? "sd2t2ohlcv" : "sd2ohlcv";
        const upstream = `https://stooq.com/q/${endpoint}/l/?s=${encodeURIComponent(stq)}&f=${fields}&h&e=csv`;
        const response = await fetch(upstream, {
            headers: { "User-Agent": UA_MARKET, "Accept": "text/csv,text/plain,*/*" },
            cf: { cacheTtl: 15, cacheEverything: true },
        });
        if (!response.ok) throw new Error(`stooq_http_${response.status}`);
        const text = await response.text();
        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) throw new Error("stooq_no_history");
        const num = (v) => {
            if (v === "N/D" || v === "" || v === undefined) return null;
            const n = Number(v);
            return isFinite(n) ? n : null;
        };
        const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
        const hasTime = header.includes("time");
        const openIdx = header.indexOf("open");
        const highIdx = header.indexOf("high");
        const lowIdx = header.indexOf("low");
        const closeIdx = header.indexOf("close");
        const volIdx = header.indexOf("volume");
        const dateIdx = header.indexOf("date");
        const timeIdx = hasTime ? header.indexOf("time") : -1;
        if (openIdx < 0 || highIdx < 0 || lowIdx < 0 || closeIdx < 0 || dateIdx < 0) {
            throw new Error("stooq_bad_header");
        }
        const bars = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(",");
            if (cols.length <= closeIdx) continue;
            const open = num(cols[openIdx]);
            const high = num(cols[highIdx]);
            const low = num(cols[lowIdx]);
            const close = num(cols[closeIdx]);
            if (open === null || high === null || low === null || close === null) continue;
            const vol = volIdx >= 0 && volIdx < cols.length ? num(cols[volIdx]) : null;
            const dateStr = cols[dateIdx];
            const timeStr = timeIdx >= 0 && timeIdx < cols.length ? cols[timeIdx] : "00:00:00";
            let iso;
            try { iso = new Date(`${dateStr}T${timeStr}Z`).toISOString(); } catch (e) { iso = new Date().toISOString(); }
            bars.push({ open, high, low, close, volume: vol ?? 0, timestamp: iso, provider });
        }
        if (bars.length === 0) throw new Error("stooq_no_bars");
        if (kind === "intraday") {
            const last = bars[bars.length - 1];
            return { symbol, ...last, provider };
        }
        const lim = Math.max(1, Math.min(1000, parseInt(limit || "200", 10) || 200));
        return bars.slice(-lim);
    }
    throw new Error("stooq_unknown_kind");
}

// ============================================================================
// PROVIDER — Yahoo (universal fallback)
// ============================================================================
async function fetchYahoo(symbol, kind, interval, limit) {
    const yahooSymbol = (
        (EQUITIES_MAP[symbol] && EQUITIES_MAP[symbol].yahoo) ||
        (FUTURES_MAP[symbol] && FUTURES_MAP[symbol].yahoo) ||
        (FOREX_MAP[symbol] && FOREX_MAP[symbol].yahoo) ||
        (INDICES_MAP[symbol] && INDICES_MAP[symbol].yahoo) ||
        symbol
    );
    const range = kind === "intraday" || kind === "history" || kind === "candles" ? "2d" : "1d";
    const upstream = `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${encodeURIComponent(interval)}&range=${range}`;
    const response = await fetch(upstream, {
        headers: { "User-Agent": UA_MARKET, "Accept": "application/json" },
        cf: { cacheTtl: 10, cacheEverything: true },
    });
    if (!response.ok) throw new Error(`yahoo_http_${response.status}`);
    const raw = await response.json();
    const result = raw?.chart?.result?.[0];
    if (!result) throw new Error("yahoo_no_data");
    const meta = result.meta || {};
    const ts = result.timestamp || [];
    const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const provider = "yahoo";
    if (kind === "price") {
        const last = shapeBar(quote, ts, ts.length - 1);
        const px = meta.regularMarketPrice ?? last.close;
        if (px === null || px === undefined) throw new Error("yahoo_no_price");
        return { symbol, close: Number(px), bid: Number(px), ask: Number(px), volume: last.volume, timestamp: last.timestamp, provider };
    }
    if (kind === "intraday") {
        if (ts.length === 0) throw new Error("yahoo_no_intraday");
        const last = shapeBar(quote, ts, ts.length - 1);
        if (last.close === null) throw new Error("yahoo_no_intraday_close");
        return { symbol, ...last, provider };
    }
    if (kind === "history" || kind === "candles") {
        const lim = Math.max(1, Math.min(1000, parseInt(limit || "200", 10) || 200));
        const start = Math.max(0, ts.length - lim);
        const out = [];
        for (let i = start; i < ts.length; i++) {
            const bar = shapeBar(quote, ts, i);
            if (bar.close === null) continue;
            out.push({ ...bar, provider });
        }
        return out;
    }
    if (kind === "volume") {
        const last = shapeBar(quote, ts, ts.length - 1);
        return { symbol, volume: last.volume, volume_24h: last.volume, provider, note: "yahoo_volume_often_zero_for_crypto" };
    }
    throw new Error("yahoo_unknown_kind");
}

// ============================================================================
// PROVIDER — Binance (crypto fallback)
// ============================================================================
async function fetchBinance(symbol, kind, interval, limit) {
    const mapped = CRYPTO_MAP[symbol];
    if (!mapped || !mapped.binance) throw new Error("binance_symbol_not_mapped");
    const pair = mapped.binance;
    const provider = "binance";
    const intervalMap = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "60m": "1h", "1h": "1h", "4h": "4h", "1d": "1d" };
    const bi = intervalMap[interval] || "1m";
    if (kind === "price" || kind === "volume") {
        const upstream = `${BINANCE_HOST}/api/v3/ticker/24hr?symbol=${encodeURIComponent(pair)}`;
        const response = await fetch(upstream, { headers: { "User-Agent": UA_MARKET, "Accept": "application/json" }, cf: { cacheTtl: 5, cacheEverything: true } });
        if (!response.ok) throw new Error(`binance_http_${response.status}`);
        const d = await response.json();
        const px = Number(d.lastPrice);
        if (!px || px <= 0) throw new Error("binance_no_price");
        if (kind === "volume") {
            return { symbol, volume: Number(d.volume || 0), volume_24h: Number(d.quoteVolume || 0), provider };
        }
        return { symbol, close: px, bid: Number(d.bidPrice || px), ask: Number(d.askPrice || px), volume: Number(d.volume || 0), timestamp: new Date(d.closeTime || Date.now()).toISOString(), provider };
    }
    if (kind === "intraday" || kind === "history" || kind === "candles") {
        const lim = Math.max(1, Math.min(1000, parseInt(limit || "200", 10) || 200));
        const upstream = `${BINANCE_HOST}/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${encodeURIComponent(bi)}&limit=${lim}`;
        const response = await fetch(upstream, { headers: { "User-Agent": UA_MARKET, "Accept": "application/json" }, cf: { cacheTtl: 10, cacheEverything: true } });
        if (!response.ok) throw new Error(`binance_http_${response.status}`);
        const rows = await response.json();
        if (!Array.isArray(rows) || rows.length === 0) throw new Error("binance_no_klines");
        const bars = rows.map((r) => ({
            open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
            volume: Number(r[5]), timestamp: new Date(r[0]).toISOString(), provider,
        }));
        if (kind === "intraday") {
            const last = bars[bars.length - 1];
            return { symbol, ...last, provider };
        }
        return bars;
    }
    throw new Error("binance_unknown_kind");
}

// ============================================================================
// PROVIDER — CoinGecko (crypto fallback)
// ============================================================================
async function fetchCoinGecko(symbol, kind, interval, limit) {
    const mapped = CRYPTO_MAP[symbol];
    if (!mapped || !mapped.gecko) throw new Error("coingecko_symbol_not_mapped");
    const gecko = mapped.gecko;
    const provider = "coingecko";
    if (kind === "price" || kind === "volume") {
        const upstream = `${COINGECKO_HOST}/simple/price?ids=${encodeURIComponent(gecko)}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`;
        const response = await fetch(upstream, { headers: { "User-Agent": UA_MARKET, "Accept": "application/json" }, cf: { cacheTtl: 15, cacheEverything: true } });
        if (!response.ok) throw new Error(`coingecko_http_${response.status}`);
        const d = await response.json();
        const entry = d[gecko];
        if (!entry || !entry.usd) throw new Error("coingecko_no_price");
        if (kind === "volume") {
            return { symbol, volume: Number(entry.usd_24h_vol || 0), volume_24h: Number(entry.usd_24h_vol || 0), provider };
        }
        return { symbol, close: Number(entry.usd), bid: Number(entry.usd), ask: Number(entry.usd), volume: Number(entry.usd_24h_vol || 0), timestamp: new Date().toISOString(), provider };
    }
    if (kind === "intraday" || kind === "history" || kind === "candles") {
        const days = (kind === "intraday") ? "1" : "2";
        const upstream = `${COINGECKO_HOST}/coins/${encodeURIComponent(gecko)}/market_chart?vs_currency=usd&days=${days}`;
        const response = await fetch(upstream, { headers: { "User-Agent": UA_MARKET, "Accept": "application/json" }, cf: { cacheTtl: 30, cacheEverything: true } });
        if (!response.ok) throw new Error(`coingecko_http_${response.status}`);
        const d = await response.json();
        const prices = d.prices || [];
        const vols = d.total_volumes || [];
        if (prices.length === 0) throw new Error("coingecko_no_prices");
        const bars = prices.map((p, i) => ({
            open: Number(p[1]), high: Number(p[1]), low: Number(p[1]), close: Number(p[1]),
            volume: vols[i] ? Number(vols[i][1]) : 0,
            timestamp: new Date(p[0]).toISOString(), provider,
        }));
        if (kind === "intraday") {
            const last = bars[bars.length - 1];
            return { symbol, ...last, provider };
        }
        const lim = Math.max(1, Math.min(1000, parseInt(limit || "200", 10) || 200));
        return bars.slice(-lim);
    }
    throw new Error("coingecko_unknown_kind");
}

// ============================================================================
// PROVIDER DISPATCH — market fusion class routing
// ============================================================================
// Crypto:          Kraken → Binance → CoinGecko → Yahoo
// Equities/Futures: Stooq  → Yahoo
// Forex/Indices:   Yahoo only
// ============================================================================
async function dispatchProvider(symbol, kind, interval, limit) {
    const isCrypto = Boolean(CRYPTO_MAP[symbol]);
    const isFutures = Boolean(FUTURES_MAP[symbol]);
    const isEquities = Boolean(EQUITIES_MAP[symbol]);
    const isForex = Boolean(FOREX_MAP[symbol]);
    const isIndices = Boolean(INDICES_MAP[symbol]);
    const errors = [];

    if (isCrypto) {
        for (const fn of [fetchKraken, fetchBinance, fetchCoinGecko, fetchYahoo]) {
            try { return await fn(symbol, kind, interval, limit); }
            catch (e) { errors.push(`${fn.name}:${e.message}`); }
        }
    } else if (isFutures || isEquities) {
        for (const fn of [fetchStooq, fetchYahoo]) {
            try { return await fn(symbol, kind, interval, limit); }
            catch (e) { errors.push(`${fn.name}:${e.message}`); }
        }
    } else if (isForex || isIndices) {
        try { return await fetchYahoo(symbol, kind, interval, limit); }
        catch (e) { errors.push(`yahoo:${e.message}`); }
    } else {
        try { return await fetchYahoo(symbol, kind, interval, limit); }
        catch (e) { errors.push(`yahoo:${e.message}`); }
    }
    throw new Error("all_providers_failed:" + errors.join("|"));
}

// ============================================================================
// WORKER ENTRY POINT — dual-route dispatch
// ============================================================================
export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders() });
        }

        if (url.pathname === "/health") {
            return jsonResponse({
                ok: true,
                service: "ae-fused-relay",
                version: "Final, First edition",
                gated: Boolean(env.RELAY_KEY),
                endpoints: [
                    "GET /?url=<https-url>",
                    "GET /?symbol=<S>&kind=<price|volume|intraday|history|candles>&interval=<tf>&limit=<n>",
                    "GET /health"
                ],
                crawler: {
                    max_html_bytes: MAX_HTML_BYTES,
                    max_links: MAX_LINKS,
                    fetch_timeout_ms: FETCH_TIMEOUT_MS,
                    user_agent: UA_CRAWLER,
                },
                market: {
                    providers: ["kraken", "stooq", "binance", "coingecko", "yahoo"],
                    primary_crypto: "kraken",
                    primary_futures: "stooq",
                    primary_equities: "stooq",
                    primary_forex: "yahoo",
                    primary_indices: "yahoo",
                    fallback_crypto: ["binance", "coingecko", "yahoo"],
                    fallback_futures: ["yahoo"],
                    fallback_equities: ["yahoo"],
                    fallback_forex: [],
                    fallback_indices: [],
                    crypto_pairs: Object.keys(CRYPTO_MAP).length,
                    futures_symbols: Object.keys(FUTURES_MAP).length,
                    equities_symbols: Object.keys(EQUITIES_MAP).length,
                    forex_pairs: Object.keys(FOREX_MAP).length,
                    indices_symbols: Object.keys(INDICES_MAP).length,
                },
            });
        }

        if (env.RELAY_KEY) {
            const presented = request.headers.get("X-Relay-Key") || "";
            if (presented !== env.RELAY_KEY) {
                return jsonResponse({
                    ok: false,
                    error: "unauthorized",
                    detail: "X-Relay-Key missing or does not match RELAY_KEY",
                }, 401);
            }
        }

        if (request.method !== "GET") {
            return jsonResponse({
                ok: false,
                error: "method_not_allowed",
                detail: "Only GET and OPTIONS are supported",
            }, 405);
        }

        const urlParam = url.searchParams.get("url");
        const symbolParam = url.searchParams.get("symbol");

        // Route 1: crawler fetch (url=...)
        if (urlParam) {
            if (!isValidHttpUrl(urlParam)) {
                return jsonResponse({
                    ok: false,
                    error: "invalid_url",
                    detail: "URL must be a well-formed http:// or https:// URL, and must not point to a private address",
                    url: urlParam,
                }, 400);
            }
            try {
                const result = await fetchCrawlerOne(urlParam);
                const status = result.ok ? 200 : (result.status >= 400 ? 502 : 500);
                return jsonResponse(result, status);
            } catch (e) {
                return jsonResponse({
                    ok: false,
                    url: urlParam,
                    error: "internal_error",
                    detail: String(e && e.message ? e.message : e),
                    status: 500,
                }, 500);
            }
        }

        // Route 2: market fetch (symbol=...)
        if (symbolParam) {
            const kind = url.searchParams.get("kind") || "price";
            const interval = url.searchParams.get("interval") || "1m";
            const limit = url.searchParams.get("limit") || "200";
            if (kind === "projection") {
                return jsonResponse({ error: "projection_is_backend_only", detail: "Call /projection on the Heroku backend, not the Worker." }, 400);
            }
            try {
                const result = await dispatchProvider(symbolParam, kind, interval, limit);
                return jsonResponse(result);
            } catch (e) {
                return jsonResponse({ error: "all_providers_failed", detail: String(e), symbol: symbolParam, kind }, 502);
            }
        }

        // Neither route selected
        return jsonResponse({
            ok: false,
            error: "missing_route",
            detail: "Provide either ?url=<https-url> for crawler fetch, or ?symbol=<S>&kind=<price|volume|intraday|history|candles> for market data.",
            endpoints: [
                "GET /?url=<https-url>",
                "GET /?symbol=<S>&kind=<price|volume|intraday|history|candles>&interval=<tf>&limit=<n>",
                "GET /health"
            ],
        }, 400);
    },
};