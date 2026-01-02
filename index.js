import dotenv from 'dotenv';
import pkg from 'ethers';
// const { Wallet } = pkg;
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import fs from 'fs';

dotenv.config();

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const CLOB_API_URL = 'https://clob.polymarket.com';
const DATA_API_URL = 'https://data-api.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet
const SIGNATURE_TYPE = 2; // Poly proxy wallet signature type

const PRIVATE_KEY = process.env.PRIVATE_KEY;
// Funder address = your Polymarket proxy wallet (shown under profile picture on polymarket.com)
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;

// Target address to mirror trades from
const TARGET_ADDRESS = '0x589222a5124a96765443b97a3498d89ffd824ad2';

// Polling interval in milliseconds (1 second)
const POLL_INTERVAL = 1000;

let clobClient = null;
let wallet = null;

// Track seen trade IDs to avoid duplicates
const seenTrades = new Set();

// Track the latest timestamp to only fetch new trades
let lastTimestamp = Math.floor(Date.now() / 1000);

// ═══════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function formatTimestamp(unixTimestamp) {
  if (unixTimestamp) {
    return new Date(unixTimestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);
  }
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function formatPrice(price) {
  const p = parseFloat(price);
  return isNaN(p) ? 'N/A' : `$${p.toFixed(4)}`;
}

function formatSize(size) {
  const s = parseFloat(size);
  return isNaN(s) ? 'N/A' : s.toFixed(2);
}

// ═══════════════════════════════════════════════════════════════
// AUTH - SETUP CLOB CLIENT (REPLICATED FROM My-Bot)
// ═══════════════════════════════════════════════════════════════

async function setupClobClient() {
  const host = 'https://clob.polymarket.com';
  const funder = '0xa9456cecF9d6fb545F6408E0e2DbBFA307d7BaE6';
  const privateKey = 'e77b39cfca7a712111553384b26d7e0d9b399e04db5891cc999964d22bc7700b';
  
  if (!privateKey)
    throw new Error('Private key is not set in environment variables');
  
  const signer = new Wallet(privateKey);

  // Step 1: Create temp client and derive credentials (exactly like My-Bot)
  const creds = await new ClobClient(
    host,
    137,
    signer
  ).createOrDeriveApiKey();

  const signatureType = 2;

  // Step 2: Create authenticated client with credentials
  clobClient = new ClobClient(
    host,
    137,
    signer,
    creds,
    signatureType,
    funder
  );

  console.log('✅ CLOB client ready for trading');
  
  return clobClient;
}

// ═══════════════════════════════════════════════════════════════
// TRADE MIRRORING - BUY/SELL EXECUTION
// ═══════════════════════════════════════════════════════════════

async function mirrorTrade(tradeData) {
  const { asset, side, size, price } = tradeData;
  
  // Validate required fields
  if (!asset || !side || !size || !price) {
    console.error('❌ Cannot mirror trade - missing required fields:');
    console.error(`   asset: ${asset}, side: ${side}, size: ${size}, price: ${price}`);
    return null;
  }
  
  console.log('\n🔄 MIRRORING TRADE...');
  console.log(`   Token ID: ${asset}`);
  console.log(`   Side: ${side} | Size: ${size} | Price: ${formatPrice(price)}`);
  
  try {
    // Round price to valid tick size (0.001 increments, 0.01-0.99 range)
    let roundedPrice = Math.round(parseFloat(price) * 1000) / 1000;
    roundedPrice = Math.max(0.01, Math.min(0.99, roundedPrice));
    
    // Round size to 2 decimal places
    const roundedSize = Math.round(parseFloat(size) * 100) / 100;
    
    const orderSide = side === 'BUY' ? Side.BUY : Side.SELL;
    
    // Build order parameters with all required fields
    const orderParams = {
      tokenID: asset,
      side: orderSide,
      size: roundedSize,
      price: roundedPrice,
      feeRateBps: 0,
      // nonce: 0,
      // expiration: 0,
    };
    
    console.log('📝 Creating order with params:', JSON.stringify(orderParams, null, 2));
    
    // Step 1: Create the signed order
    const order = await clobClient.createOrder(orderParams);
    
    console.log('📤 Posting order to CLOB...');
    console.log('   Order:', JSON.stringify(order, null, 2));
    
    // Step 2: Post the order (GTC = Good Till Cancelled)
    const result = await clobClient.postOrder(order, OrderType.IOC);
    if (result.success) {
      console.log('Order executedd ✅', result);
    } else {
      console.log('Order failed ❌', result);
    }    
    // console.log('✅ Order placed successfully!');

    
    return result;
  } catch (error) {
    console.error('❌ Failed to mirror trade:', error.message);
    if (error.response?.data) {
      console.error('   API Error:', JSON.stringify(error.response.data));
    }
    console.error('   Full error:', error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// TRADE LOGGING
// ═══════════════════════════════════════════════════════════════

function logTrade(trade) {
  // The Data API already includes market details!
  console.log('\n' + '═'.repeat(65));
  console.log(`🎯 [${formatTimestamp(trade.timestamp)}] TARGET TRADE DETECTED`);
  console.log('═'.repeat(65));
  console.log(`   Market: "${trade.title}"`);
  console.log(`   Outcome: ${trade.outcome}`);
  console.log(`   Side: ${trade.side} | Price: ${formatPrice(trade.price)} | Size: ${formatSize(trade.size)}`);
  console.log(`   USDC Value: $${parseFloat(trade.usdcSize || 0).toFixed(2)}`);
  console.log(`   Condition ID: ${trade.conditionId}`);
  console.log(`   Token ID: ${trade.asset}`);
  console.log(`   Tx Hash: ${trade.transactionHash}`);
  console.log(`   Trader: ${trade.name || trade.pseudonym || trade.proxyWallet}`);
  console.log('═'.repeat(65));
  
  // Mirror the trade
  mirrorTrade({
    asset: trade.asset,
    side: trade.side,
    size: trade.size,
    price: trade.price,
  });
}

// ═══════════════════════════════════════════════════════════════
// POLLING - FETCH TARGET'S TRADES
// ═══════════════════════════════════════════════════════════════

async function fetchTargetActivity() {
  try {
    const response = await fetch(
      `${DATA_API_URL}/activity?user=${TARGET_ADDRESS}&limit=200`
    );
    
    if (!response.ok) {
      console.error(`❌ API Error: ${response.status} ${response.statusText}`);
      return [];
    }
    
    const activity = await response.json();
    
    // Filter for trades only (not orders, not other activity types)
    return activity.filter(item => item.type === 'TRADE');
  } catch (error) {
    console.error(`❌ Error fetching activity: ${error.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// DUMP RECENT TRADES TO CSV
// ═══════════════════════════════════════════════════════════════

async function dumpRecentTradesToCSV(secondsAgo = 5, outputFile = 'recent_trades.csv') {
  console.log(`\n📊 Fetching trades from the last ${secondsAgo} seconds...`);
  
  const nowTimestamp = Math.floor(Date.now() / 1000);
  const cutoffTimestamp = nowTimestamp - secondsAgo;
  
  try {
    // Fetch all activity
    const trades = await fetchTargetActivity();
    console.log('trades', trades.length);
    // Filter trades from the last X seconds
    // const recentTrades = trades.filter(trade => trade.timestamp >= cutoffTimestamp);
    const recentTrades = trades;
    // console.log(`   Found ${recentTrades.length} trades in the last ${secondsAgo} seconds`);
    
    if (recentTrades.length === 0) {
      console.log('   No trades to dump.');
      return [];
    }
    
    // Log trades to console
    console.log('\n📋 Recent Trades:');
    console.log('─'.repeat(80));
    recentTrades.forEach((trade, idx) => {
      console.log(`   ${idx + 1}. [${formatTimestamp(trade.timestamp)}] ${trade.side} ${formatSize(trade.size)} @ ${formatPrice(trade.price)}`);
      console.log(`      Market: ${trade.title}`);
      console.log(`      Outcome: ${trade.outcome} | USDC: $${parseFloat(trade.usdcSize || 0).toFixed(2)}`);
    });
    console.log('─'.repeat(80));
    
    // Build CSV content
    const headers = [
      'timestamp',
      'datetime',
      'side',
      'price',
      'size',
      'usdcSize',
      'title',
      'outcome',
      'asset',
      'conditionId',
      'transactionHash',
      'trader'
    ];
    
    const csvRows = [headers.join(',')];
    
    for (const trade of recentTrades) {
      const row = [
        trade.timestamp,
        formatTimestamp(trade.timestamp),
        trade.side,
        trade.price,
        trade.size,
        trade.usdcSize || 0,
        `"${(trade.title || '').replace(/"/g, '""')}"`,  // Escape quotes in title
        `"${(trade.outcome || '').replace(/"/g, '""')}"`,
        trade.asset,
        trade.conditionId,
        trade.transactionHash,
        trade.name || trade.pseudonym || trade.proxyWallet || ''
      ];
      csvRows.push(row.join(','));
    }
    
    const csvContent = csvRows.join('\n');
    
    // Write to file
    fs.writeFileSync(outputFile, csvContent);
    console.log(`\n✅ Dumped ${recentTrades.length} trades to ${outputFile}`);
    
    return recentTrades;
  } catch (error) {
    console.error(`❌ Error dumping trades: ${error.message}`);
    return [];
  }
}

async function pollForTrades() {
  const trades = await fetchTargetActivity();
  
  // Sort by timestamp descending to process newest first
  trades.sort((a, b) => b.timestamp - a.timestamp);
  
  let newTradeCount = 0;
  
  for (const trade of trades) {
    // Create unique ID from transaction hash + asset
    const tradeId = `${trade.transactionHash}-${trade.asset}`;
    
    // Skip if we've already seen this trade
    if (seenTrades.has(tradeId)) {
      continue;
    }
    
    // Skip trades from before we started
    if (trade.timestamp < lastTimestamp - 5) {
      // Add to seen so we don't process old trades
      seenTrades.add(tradeId);
      continue;
    }
    
    // Mark as seen
    seenTrades.add(tradeId);
    
    // Log the new trade
    logTrade(trade);
    newTradeCount++;
  }
  
  // Update last timestamp if we found new trades
  if (trades.length > 0 && trades[0].timestamp > lastTimestamp) {
    lastTimestamp = trades[0].timestamp;
  }
  
  // Limit the size of seenTrades to prevent memory issues
  if (seenTrades.size > 10000) {
    const entries = Array.from(seenTrades);
    entries.slice(0, 5000).forEach(id => seenTrades.delete(id));
  }
}

function startPolling() {
  console.log(`\n📡 Starting to poll for trades every ${POLL_INTERVAL}ms`);
  console.log(`👁️  Watching: ${TARGET_ADDRESS}`);
  console.log(`📊 Using Data API: ${DATA_API_URL}/activity`);
  console.log('\n⏳ Waiting for new trades...\n');
  
  // Initial poll
  pollForTrades();
  
  // Set up recurring polls
  setInterval(pollForTrades, POLL_INTERVAL);
}

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

function validateConfig() {
  if (!PRIVATE_KEY) {
    console.error('❌ Missing PRIVATE_KEY in .env file');
    console.error('   Required: PRIVATE_KEY (your Ethereum wallet private key)');
    process.exit(1);
  }
  
  // Basic validation - should be 64 hex chars (with or without 0x prefix)
  const cleanKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY.slice(2) : PRIVATE_KEY;
  if (!/^[a-fA-F0-9]{64}$/.test(cleanKey)) {
    console.error('❌ Invalid PRIVATE_KEY format');
    console.error('   Should be 64 hex characters (with or without 0x prefix)');
    process.exit(1);
  }
  
  if (!FUNDER_ADDRESS) {
    console.error('❌ Missing FUNDER_ADDRESS in .env file');
    console.error('   Required: Your Polymarket proxy wallet address (shown under profile picture)');
    process.exit(1);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   POLYMARKET TRADE MIRROR');
  console.log('   Real-time trade tracking & execution via CLOB API');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // validateConfig();
  
  // Setup CLOB client for executing trades (for future use)
  // await setupClobClient();
  
  // Dump recent trades from last 5 seconds to CSV
  await dumpRecentTradesToCSV(5, 'recent_trades.csv');
  
  // Start polling for target's trades
  // startPolling();
}

main();
