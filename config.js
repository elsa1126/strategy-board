/* =========================================================
   策略看板 v10 — 設定檔
   幣種清單、報價金鑰、雲端設定都集中在這裡；主程式在 app.js
   ========================================================= */

// ===================== 幣種清單 =====================
// 預設會載入的幣種。也可以用管理員身分在「設定 → 新增幣種」直接加，不必改這裡
const COIN_LIST_DEFAULT = ['1INCH', 'A', 'A2Z', 'AB', 'ACH', 'ACT', 'AEVO', 'AGI', 'AI', 'ALGO', 'ALT', 'ANIME', 'APE', 'APT', 'ARPA', 'ATA', 'AWE', 'AXS', 'BABYDOGE', 'BAN', 'BEL', 'BLUR', 'BOME', 'BONK', 'C98', 'CAKE', 'CAT', 'CELR', 'CFX', 'CHR', 'CHZ', 'CKB', 'COS', 'COTI', 'CRO', 'CSPR', 'CTSI', 'CVC', 'DEGO', 'DENT', 'DGB', 'DODO', 'DOGE', 'DOGE/BTC', 'DOGS', 'DOT', 'DUSK', 'EDU', 'ENA', 'ENJ', 'ENS', 'ETH/BTC', 'FET', 'FLM', 'FLOKI', 'FLR', 'FORM', 'FTT', 'FUN', 'GALA', 'GMT', 'GOAT', 'GRT', 'GT', 'HBAR', 'HFT', 'HIGH', 'HIVE', 'HMSTR', 'HOOK', 'HTX', 'ICP', 'ID', 'IDEX', 'IMX', 'IO', 'IOST', 'IOTA', 'IQ', 'JASMY', 'JOE', 'KAVA', 'KDA', 'KNC', 'LAT', 'LINK', 'LRC', 'LTC', 'LUNC', 'MANA', 'MANTA', 'MAV', 'MBOX', 'MEME', 'MOG', 'NEAR', 'NEIRO', 'NFT', 'NKN', 'NOT', 'OM', 'ONE', 'OXT', 'PENGU', 'PEOPLE', 'PEPE', 'PHA', 'PI', 'PIXEL', 'PNUT', 'POL', 'POND', 'PORTAL', 'PSG', 'PYTH', 'QKC', 'RAD', 'RARE', 'RATS', 'RDNT', 'RSR', 'RUNE', 'SAND', 'SATS', 'SEI', 'SFP', 'SHIB', 'SKL', 'SOL', 'SPELL', 'STRK', 'STX', 'SUI', 'SUSHI', 'SYS', 'TFUEL', 'THETA', 'TKO', 'TLM', 'TRUMP', 'TRX', 'TURBO', 'UNI', 'VOXEL', 'VTHO', 'W', 'WAXP', 'WEN', 'WIN','WLD', 'WOO', 'XAI', 'XEC', 'XVG', 'XRP/BTC', 'XVS', 'YGG',  'ZBCN', 'ZIL'];
const REMOVED_COINS = ['GEAR', 'XRP', 'ETH'];   // 已刪除的幣種（本機與雲端都不再載入）

// ===================== 雲端同步（JSONBin） =====================
const DEFAULT_BIN_ID = '69ef8fb0856a6821897b7cf0';

// 管理員帳密的檢查已經搬到 Worker（安全模式），網頁這邊不再放帳密雜湊

// 安全模式：部署 worker/ 資料夾裡的 Cloudflare Worker 之後，把網址填在這裡（結尾不要加斜線）
// 填了之後，讀寫雲端、管理員登入、CoinGecko 報價都改走 Worker，網頁不再全面依賴 API_KEY
// 詳細步驟見 worker/部署說明.md
const WORKER_URL = 'https://strategy-board-api.elsa-board.workers.dev';

// ===================== CoinGecko 報價設定 =====================
// 👇 請在這裡填入你的 CoinGecko API 金鑰
const COINGECKO_API_KEY = 'CG-6GuPmwJhFp7UjmzTXYw23g7T';
// 金鑰類型：'demo'（免費 Demo 金鑰） 或 'pro'（付費方案金鑰）
const COINGECKO_PLAN = 'demo';
// 👇 備用金鑰（選填）：主金鑰額度用完、金鑰錯誤或連線失敗時自動改用；留空 = 不啟用
const COINGECKO_API_KEY_BACKUP = 'CG-zK4XX21TMk4g8oTWC6Pg3gmC';
const COINGECKO_PLAN_BACKUP = 'demo';
// 👇 第三把金鑰（選填）：前兩把都不能用時才會用到；從第 3 把起，一旦用到就會跳出警示提醒你 c0983188451
const COINGECKO_API_KEY_BACKUP2 = 'CG-tc5od7LRXTuANHu9BCBYngh6';
const COINGECKO_PLAN_BACKUP2 = 'demo';
// 👇 第四、第五把金鑰（選填）b0983,jun
const COINGECKO_API_KEY_BACKUP3 = 'CG-n74MvN36GYNJ7ffTUDLuhBHU';
const COINGECKO_PLAN_BACKUP3 = 'demo';
const COINGECKO_API_KEY_BACKUP4 = 'CG-RFZxFEq4v12LW7pvvJ4XVD91';
const COINGECKO_PLAN_BACKUP4 = 'demo';
// =============================================================

const COINGECKO_BASE = COINGECKO_PLAN === 'pro' ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
const COINGECKO_KEY_PARAM = COINGECKO_PLAN === 'pro' ? 'x_cg_pro_api_key' : 'x_cg_demo_api_key';
const REFRESH_SECONDS = 300;      // 每 5 分鐘更新一次
const MIN_FETCH_GAP_MS = 60000;   // 非定時觸發（切回前景、雲端同步）的最短間隔，避免多耗額度

// 幣種代號 → CoinGecko 幣 ID。新增幣種時請在這裡補一行；沒對照的幣會顯示「暫無報價」
const COIN_ID_MAP = {
    '1INCH': '1inch', 'A': 'vaulta', 'A2Z': 'arena-z', 'AB': 'newton-project',
    'ACH': 'alchemy-pay', 'ACT': 'act-i-the-ai-prophecy', 'AEVO': 'aevo-exchange', 'AGI': 'delysium',
    'AI': 'sleepless-ai', 'ALGO': 'algorand', 'ALT': 'altlayer', 'ANIME': 'anime',
    'APE': 'apecoin', 'APT': 'aptos', 'ARPA': 'arpa', 'AWE': 'awe', 'ATA': 'automata',
    'AXS': 'axie-infinity', 'BABYDOGE': 'baby-doge-coin', 'BAN': 'comedian', 'BEL': 'bella-protocol',
    'BLUR': 'blur', 'BOME': 'book-of-meme', 'BONK': 'bonk', 'C98': 'coin98',
    'CAKE': 'pancakeswap-token', 'CAT': 'simon-s-cat', 'CELR': 'celer-network', 'CFX': 'conflux-token',
    'CHR': 'chromaway', 'CHZ': 'chiliz', 'CKB': 'nervos-network', 'COS': 'contentos',
    'COTI': 'coti', 'CRO': 'crypto-com-chain', 'CSPR': 'casper-network', 'CTSI': 'cartesi',
    'CVC': 'civic', 'DEGO': 'dego-finance', 'DENT': 'dent', 'DGB': 'digibyte',
    'DODO': 'dodo', 'DOGE': 'dogecoin', 'DOGS': 'dogs-2', 'DOT': 'polkadot',
    'DUSK': 'dusk-network', 'EDU': 'edu-coin', 'ENA': 'ethena', 'ENJ': 'enjincoin',
    'ENS': 'ethereum-name-service', 'FET': 'fetch-ai', 'FLM': 'flamingo-finance', 'FLOKI': 'floki',
    'FLR': 'flare-networks', 'FORM': 'four', 'FTT': 'ftx-token', 'FUN': 'funfair',
    'GALA': 'gala', 'GMT': 'stepn', 'GOAT': 'goatseus-maximus',
    'GRT': 'the-graph', 'GT': 'gatechain-token', 'HBAR': 'hedera-hashgraph', 'HFT': 'hashflow',
    'HIGH': 'highstreet', 'HIVE': 'hive', 'HMSTR': 'hamster-kombat', 'HOOK': 'hooked-protocol',
    'HTX': 'htx-dao', 'ICP': 'internet-computer', 'ID': 'space-id', 'IDEX': 'aurora-dao', 'IMX': 'immutable-x',
    'IO': 'io', 'IOST': 'iostoken', 'IOTA': 'iota', 'IQ': 'everipedia',
    'JASMY': 'jasmycoin', 'JOE': 'joe', 'KAVA': 'kava', 'KDA': 'kadena',
    'KNC': 'kyber-network-crystal', 'LAT': 'platon-network', 'LINK': 'chainlink', 'LRC': 'loopring',
    'LTC': 'litecoin', 'LUNC': 'terra-luna', 'MANA': 'decentraland', 'MANTA': 'manta-network',
    'MAV': 'maverick-protocol', 'MBOX': 'mobox', 'MEME': 'memecoin-2', 'MOG': 'mog-coin',
    'NEAR': 'near', 'NEIRO': 'neiro-3', 'NFT': 'apenft', 'NKN': 'nkn',
    'NOT': 'notcoin', 'OM': 'mantra-dao', 'ONE': 'harmony', 'OXT': 'orchid-protocol',
    'PENGU': 'pudgy-penguins', 'PEOPLE': 'constitutiondao', 'PEPE': 'pepe', 'PHA': 'pha',
    'PI': 'pi-network', 'PIXEL': 'pixels', 'PNUT': 'peanut-the-squirrel', 'POL': 'polygon-ecosystem-token',
    'POND': 'marlin', 'PORTAL': 'portal-2', 'PSG': 'paris-saint-germain-fan-token', 'PYTH': 'pyth-network',
    'QKC': 'quark-chain', 'RAD': 'radicle', 'RARE': 'superrare', 'RATS': 'rats',
    'RDNT': 'radiant-capital', 'RSR': 'reserve-rights-token', 'RUNE': 'thorchain', 'SAND': 'the-sandbox',
    'SATS': 'sats-ordinals', 'SEI': 'sei-network', 'SFP': 'safepal', 'SHIB': 'shiba-inu',
    'SKL': 'skale', 'SOL': 'solana', 'SPELL': 'spell-token', 'STRK': 'starknet',
    'STX': 'blockstack', 'SUI': 'sui', 'SUSHI': 'sushi', 'SYS': 'syscoin',
    'TFUEL': 'theta-fuel', 'THETA': 'theta-token', 'TKO': 'tokocrypto', 'TLM': 'alien-worlds',
    'TRUMP': 'official-trump', 'TRX': 'tron', 'TURBO': 'turbo', 'UNI': 'uniswap',
    'VOXEL': 'voxies', 'VTHO': 'vethor-token', 'W': 'wormhole', 'WAXP': 'wax',
    'WEN': 'wen-4', 'WIN': 'wink', 'WLD': 'worldcoin-wld', 'WOO': 'woo-network',
    'XAI': 'xai-blockchain', 'XEC': 'ecash', 'XVG': 'verge', 'XVS': 'venus',
    'YGG': 'yield-guild-games', 'ZBCN': 'zebec-network', 'ZIL': 'zilliqa',
};

// ===================== Binance 報價設定 =====================
// 來源：https://api.binance.com/api/v3/ticker/price（只有現價，沒有 24h 漲跌與成交量）
const BINANCE_PRICE_URL = 'https://api.binance.com/api/v3/ticker/price';
// 幣/BTC 交易對：直接用 ticker/price?symbol=XXXBTC 的原始價格，以 BTC 為單位顯示（不換算美元、不走 CoinGecko）
const BINANCE_BTC_PAIRS = { 'DOGE/BTC': 'DOGEBTC', 'XRP/BTC': 'XRPBTC', 'ETH/BTC': 'ETHBTC' };
// 一律使用幣安 /USDT 報價（不走 CoinGecko）
const BINANCE_ONLY = ['AI'];
// CoinGecko 查不到報價時，改用幣安 /USDT 備援
const BINANCE_FALLBACK = ['FET', 'PHA', 'IO', 'NEIRO', 'AWE', 'CAT', 'IDEX', 'ATA'];
