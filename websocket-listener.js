import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

// Target address to monitor trades for
// const TARGET_ADDRESS = '0x589222a5124a96765443b97a3498d89ffd824ad2'.toLowerCase();
const TARGET_ADDRESS = '0xa9456cecF9d6fb545F6408E0e2DbBFA307d7BaE6'.toLowerCase();

// Polygon WebSocket URL (Alchemy recommended - free tier available)
// Sign up at https://alchemy.com to get your API key
const WSS_URL = 'wss://polygon-bor-rpc.publicnode.com';

// Polymarket Exchange Contracts
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// OrderFilled event ABI
const ORDER_FILLED_ABI = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)'
];

// ═══════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

// Cache for token ID to outcome mapping
const tokenOutcomeCache = new Map();

/**
 * Get outcome name (Yes/No) from token ID by querying Polymarket API
 * @param {string} tokenId - Token ID
 * @returns {Promise<string|null>} Outcome name (Yes/No) or null
 */
async function getOutcomeFromTokenId(tokenId) {
  // Check cache first
  if (tokenOutcomeCache.has(tokenId)) {
    return tokenOutcomeCache.get(tokenId);
  }
  
  try {
    // Query CLOB API for token info
    const tokenResponse = await fetch(`https://clob.polymarket.com/token?id=${tokenId}`);
    
    if (tokenResponse.ok) {
      const tokenData = await tokenResponse.json();
      
      // Token data usually has outcome field
      if (tokenData?.outcome) {
        const outcome = tokenData.outcome;
        tokenOutcomeCache.set(tokenId, outcome);
        return outcome;
      }
      
      // If we have marketId, fetch market details
      if (tokenData?.marketId) {
        const marketResponse = await fetch(`https://data-api.polymarket.com/markets/${tokenData.marketId}`);
        if (marketResponse.ok) {
          const marketData = await marketResponse.json();
          
          // Find which outcome this token represents
          if (marketData.tokens && Array.isArray(marketData.tokens)) {
            const tokenInfo = marketData.tokens.find(t => t.tokenId === tokenId);
            if (tokenInfo?.outcome) {
              const outcome = tokenInfo.outcome;
              tokenOutcomeCache.set(tokenId, outcome);
              return outcome;
            }
          }
          
          // Fallback: check outcomes array
          if (marketData.outcomes && Array.isArray(marketData.outcomes)) {
            // Token ID encoding: outcomeIndex is typically tokenId % 2 for binary markets
            // But this is not always reliable, so we prefer API data
            const outcomeIndex = parseInt(tokenId) % 2;
            if (marketData.outcomes[outcomeIndex]) {
              const outcome = marketData.outcomes[outcomeIndex];
              tokenOutcomeCache.set(tokenId, outcome);
              return outcome;
            }
          }
        }
      }
    }
    
    // Fallback: Try orderbook API
    const bookResponse = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    if (bookResponse.ok) {
      const bookData = await bookResponse.json();
      if (bookData?.market?.outcomes && Array.isArray(bookData.market.outcomes)) {
        // Try to match token ID to outcome
        const tokenInfo = bookData.market.tokens?.find(t => t.tokenId === tokenId);
        if (tokenInfo?.outcome) {
          const outcome = tokenInfo.outcome;
          tokenOutcomeCache.set(tokenId, outcome);
          return outcome;
        }
      }
    }
    
    return null;
  } catch (error) {
    // Silently fail - outcome detection is optional
    return null;
  }
}

function determineTradeType(trade) {
  const targetLower = TARGET_ADDRESS.toLowerCase();
  const makerLower = trade.maker.toLowerCase();
  const takerLower = trade.taker.toLowerCase();
  const isMaker = makerLower === targetLower;
  const isTaker = takerLower === targetLower;
  
  // Asset ID = 0 means USDC, Asset ID != 0 means tokens
  const ZERO_ASSET = '0';
  
  if (isMaker) {
    // Target is the maker
    if (trade.makerAssetId === ZERO_ASSET) {
      // Giving USDC (0), receiving tokens (!= 0) = BUY
      return 'BUY';
    } else {
      // Giving tokens (!= 0), receiving USDC (0) = SELL
      return 'SELL';
    }
  } else if (isTaker) {
    // Target is the taker
    if (trade.takerAssetId === ZERO_ASSET) {
      // Receiving USDC (0), giving tokens (!= 0) = SELL
      return 'SELL';
    } else {
      // Receiving tokens (!= 0), giving USDC (0) = BUY
      return 'BUY';
    }
  }
  
  return 'UNKNOWN';
}

function logTrade(trade, contractName) {
  const now = new Date();
  const tradeType = determineTradeType(trade);
  const tradeTypeEmoji = tradeType === 'BUY' ? '🟢' : tradeType === 'SELL' ? '🔴' : '⚪';
  
  // Determine which token ID represents the outcome being traded
  const targetLower = TARGET_ADDRESS.toLowerCase();
  const isMaker = trade.maker.toLowerCase() === targetLower;
  const isTaker = trade.taker.toLowerCase() === targetLower;
  
  // Token ID that represents the outcome (not USDC)
  const outcomeTokenId = isMaker 
    ? (trade.makerAssetId !== '0' ? trade.makerAssetId : trade.takerAssetId)
    : (trade.takerAssetId !== '0' ? trade.takerAssetId : trade.makerAssetId);
  
  const outcomeDisplay = trade.outcome ? ` (${trade.outcome})` : '';
  
  console.log('\n' + '═'.repeat(70));
  console.log(`${tradeTypeEmoji} [${formatTimestamp(now)}] ${tradeType}${outcomeDisplay} TRADE DETECTED on ${contractName}`);
  console.log('═'.repeat(70));
  console.log(`   Type: ${tradeType}${outcomeDisplay}`);
  console.log(`   Block: ${trade.blockNumber}`);
  console.log(`   Tx Hash: ${trade.txHash}`);
  console.log(`   Order Hash: ${trade.orderHash}`);
  console.log(`   Maker: ${trade.maker}`);
  console.log(`   Taker: ${trade.taker}`);
  console.log(`   Token ID: ${outcomeTokenId}`);
  if (trade.outcome) {
    console.log(`   Outcome: ${trade.outcome}`);
  }
  console.log(`   Maker Asset ID: ${trade.makerAssetId}`);
  console.log(`   Taker Asset ID: ${trade.takerAssetId}`);
  console.log(`   Maker Amount: ${trade.makerAmountFilled}`);
  console.log(`   Taker Amount: ${trade.takerAmountFilled}`);
  console.log(`   Fee: ${trade.fee}`);
  console.log('═'.repeat(70));
}

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET LISTENER
// ═══════════════════════════════════════════════════════════════

async function startListener() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   POLYMARKET REAL-TIME TRADE LISTENER');
  console.log('   Listening via Polygon WebSocket');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  if (!WSS_URL) {
    console.error('❌ Missing POLYGON_WSS_URL in .env file');
    console.error('');
    console.error('   To get a free WebSocket URL:');
    console.error('   1. Go to https://alchemy.com and sign up (free)');
    console.error('   2. Create a new app and select "Polygon Mainnet"');
    console.error('   3. Copy the WebSocket URL (starts with wss://)');
    console.error('   4. Add to .env: POLYGON_WSS_URL=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY');
    console.error('');
    process.exit(1);
  }
  
  console.log(`🎯 Target Address: ${TARGET_ADDRESS}`);
  console.log(`🔌 Connecting to Polygon WebSocket...`);
  
  // Connect to Polygon via WebSocket
  const provider = new ethers.providers.WebSocketProvider(WSS_URL);
  
  // Handle connection events
  provider._websocket.on('open', () => {
    console.log('✅ WebSocket connected to Polygon');
  });
  
  provider._websocket.on('close', (code) => {
    console.error(`❌ WebSocket closed with code ${code}. Reconnecting in 5s...`);
    setTimeout(startListener, 5000);
  });
  
  provider._websocket.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });
  
  // Create contract interfaces
  const ctfExchange = new ethers.Contract(CTF_EXCHANGE, ORDER_FILLED_ABI, provider);
  const negRiskExchange = new ethers.Contract(NEG_RISK_CTF_EXCHANGE, ORDER_FILLED_ABI, provider);
  
  // Event handler function (no filtering needed - already filtered at blockchain level)
  const handleOrderFilled = (contractName) => {
    return async (orderHash, maker, taker, makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee, event) => {
      const trade = {
        blockNumber: event.blockNumber,
        txHash: event.transactionHash,
        orderHash: orderHash,
        maker: maker,
        taker: taker,
        makerAssetId: makerAssetId.toString(),
        takerAssetId: takerAssetId.toString(),
        makerAmountFilled: makerAmountFilled.toString(),
        takerAmountFilled: takerAmountFilled.toString(),
        fee: fee.toString()
      };
      
      // Determine trade type and add to trade object
      trade.type = determineTradeType(trade);
      
      // Determine which token ID represents the outcome (not USDC)
      const targetLower = TARGET_ADDRESS.toLowerCase();
      const isMaker = trade.maker.toLowerCase() === targetLower;
      const isTaker = trade.taker.toLowerCase() === targetLower;
      
      // Token ID that represents the outcome being traded
      const outcomeTokenId = isMaker 
        ? (trade.makerAssetId !== '0' ? trade.makerAssetId : trade.takerAssetId)
        : (trade.takerAssetId !== '0' ? trade.takerAssetId : trade.makerAssetId);
      
      // Fetch outcome name (Yes/No) from Polymarket API
      // if (outcomeTokenId && outcomeTokenId !== '0') {
      //   try {
      //     const outcome = await getOutcomeFromTokenId(outcomeTokenId);
      //     if (outcome) {
      //       trade.outcome = outcome;
      //     }
      //   } catch (error) {
      //     // Silently fail - outcome detection is optional
      //   }
      // }
      
      // Log to console
      logTrade(trade, contractName);
    };
  };
  
  // Create filters for target address as maker OR taker
  // Since maker and taker are indexed, we can filter at blockchain level
  const targetAddress = ethers.utils.getAddress(TARGET_ADDRESS);
  
  // Subscribe to filtered events (blockchain-level filtering)
  // Only events where target address is maker OR taker will be received
  console.log(`\n📡 Subscribing to filtered OrderFilled events...`);
  console.log(`   Contract 1: CTF_EXCHANGE (${CTF_EXCHANGE})`);
  console.log(`   Contract 2: NEG_RISK_CTF_EXCHANGE (${NEG_RISK_CTF_EXCHANGE})`);
  console.log(`   Filter: Target address as maker OR taker`);
  console.log(`   ✅ Only receiving events where ${TARGET_ADDRESS} is involved\n`);
  
  // Subscribe to CTF_EXCHANGE: Target as maker
  ctfExchange.on(
    ctfExchange.filters.OrderFilled(null, targetAddress, null),
    handleOrderFilled('CTF_EXCHANGE')
  );
  
  // Subscribe to CTF_EXCHANGE: Target as taker
  ctfExchange.on(
    ctfExchange.filters.OrderFilled(null, null, targetAddress),
    handleOrderFilled('CTF_EXCHANGE')
  );
  
  // Subscribe to NEG_RISK_CTF_EXCHANGE: Target as maker
  negRiskExchange.on(
    negRiskExchange.filters.OrderFilled(null, targetAddress, null),
    handleOrderFilled('NEG_RISK_CTF_EXCHANGE')
  );
  
  // Subscribe to NEG_RISK_CTF_EXCHANGE: Target as taker
  negRiskExchange.on(
    negRiskExchange.filters.OrderFilled(null, null, targetAddress),
    handleOrderFilled('NEG_RISK_CTF_EXCHANGE')
  );
  
  console.log('\n✅ Listening for trades...');
  console.log('⏳ Waiting for target trades (Ctrl+C to stop)\n');
  
  // Keep the process running
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Stopping listener...');
    provider._websocket.close();
    process.exit(0);
  });
}

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

startListener().catch((err) => {
  console.error('❌ Failed to start listener:', err.message);
  process.exit(1);
});

