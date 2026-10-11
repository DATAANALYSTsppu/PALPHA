const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
        LevelFormat, PageBreak } = require('docx');
const fs = require('fs');

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

function headerCell(text, width) {
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    shading: { fill: "1B2A4A", type: ShadingType.CLEAR },
    margins: cellMargins,
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: "FFFFFF", font: "Arial", size: 20 })] })],
  });
}

function bodyCell(text, width) {
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    margins: cellMargins,
    children: [new Paragraph({ children: [new TextRun({ text, font: "Arial", size: 20 })] })],
  });
}

function codeBlock(code) {
  return new Paragraph({
    spacing: { before: 100, after: 100 },
    children: [new TextRun({ text: code, font: "Courier New", size: 18, color: "2E2E2E" })],
  });
}

function sectionHeading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 360, after: 120 },
    children: [new TextRun({ text, bold: true, font: "Arial", size: 26, color: "1B2A4A" })],
  });
}

function subHeading(text) {
  return new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true, font: "Arial", size: 22, color: "333333" })],
  });
}

function bodyText(text) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text, font: "Arial", size: 20 })],
  });
}

function boldBodyText(label, text) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [
      new TextRun({ text: label, bold: true, font: "Arial", size: 20 }),
      new TextRun({ text, font: "Arial", size: 20 }),
    ],
  });
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 20 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial", color: "1B2A4A" },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: "Arial", color: "1B2A4A" },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    children: [
      // ─── Title ─────────────────────────────────────────────────────
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: "Code Hardening & Error Proofing", bold: true, font: "Arial", size: 36, color: "1B2A4A" })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [new TextRun({ text: "Polymarket Copy Trading Bot System", font: "Arial", size: 24, color: "666666" })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 360 },
        children: [new TextRun({ text: "PPM Technical Reference Document", font: "Arial", size: 20, color: "999999" })],
      }),

      // ─── Summary Table ─────────────────────────────────────────────
      new Paragraph({
        spacing: { before: 120, after: 200 },
        children: [new TextRun({ text: "This document outlines the code hardening measures, error recovery mechanisms, and operational safety controls implemented across the Polymarket copy trading platform. Each measure addresses a specific failure mode identified during development and production paper trading.", font: "Arial", size: 20 })],
      }),

      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [3120, 3120, 3120],
        rows: [
          new TableRow({ children: [
            headerCell("Category", 3120),
            headerCell("Controls", 3120),
            headerCell("Coverage", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Infrastructure Resilience", 3120),
            bodyCell("4 controls", 3120),
            bodyCell("Database, API, Network, SSL", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Data Integrity", 3120),
            bodyCell("3 controls", 3120),
            bodyCell("Dedup, Migration, Import resumability", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Operational Safety", 3120),
            bodyCell("3 controls", 3120),
            bodyCell("Risk limits, Kill switch, Graceful shutdown", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Access Control", 3120),
            bodyCell("2 controls", 3120),
            bodyCell("MCP tiered access, SQL injection prevention", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Architecture", 3120),
            bodyCell("4 improvements", 3120),
            bodyCell("Monorepo, unified DB, plugin system, dedup", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Cost Optimization", 3120),
            bodyCell("2 improvements", 3120),
            bodyCell("Dashboard (zero LLM tokens), controlled MCP", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Strategy Validation", 3120),
            bodyCell("2 improvements", 3120),
            bodyCell("Backtesting engine, paper/live separation", 3120),
          ]}),
        ],
      }),

      // ─── 1. Database Connection Resilience ─────────────────────────
      sectionHeading("1. Database Connection Resilience"),
      boldBodyText("Problem: ", "Cloud PostgreSQL instances require SSL connections, but self-signed certificates are rejected by default, causing connection failures in production."),
      boldBodyText("Solution: ", "Auto-detect remote vs local connections and configure SSL handling accordingly."),
      codeBlock("// packages/core/src/db/pool.ts"),
      codeBlock("const ssl = config.database.url.includes('localhost')"),
      codeBlock("  ? false"),
      codeBlock("  : { rejectUnauthorized: false };"),
      bodyText("This ensures local development works without SSL overhead while production connections are always encrypted."),

      // ─── 2. Bulk Insert Error Recovery ─────────────────────────────
      sectionHeading("2. Bulk Insert Error Recovery"),
      boldBodyText("Problem: ", "A single malformed row in a 500-row bulk INSERT causes the entire batch to fail, resulting in data loss during large imports (19M+ trade records)."),
      boldBodyText("Solution: ", "On batch failure, automatically fall back to row-by-row insertion to isolate and skip only the problematic records."),
      codeBlock("try {"),
      codeBlock("  await targetPool.query(bulkSQL, params);  // 500 rows"),
      codeBlock("} catch (err) {"),
      codeBlock("  for (const row of chunk) {"),
      codeBlock("    try { await query(singleSQL, row); } catch { }"),
      codeBlock("  }"),
      codeBlock("}"),
      bodyText("This two-tier approach maximizes throughput (bulk) while ensuring no silent data loss (fallback)."),

      // ─── 3. Signal Deduplication ───────────────────────────────────
      sectionHeading("3. Signal Deduplication"),
      boldBodyText("Problem: ", "The copy trading engine polls target traders every 60 seconds. The same trade can be detected across multiple polling cycles, leading to duplicate positions."),
      boldBodyText("Solution: ", "Timestamp-window deduplication with a +/- 1 second tolerance window."),
      codeBlock("SELECT 1 FROM copy_signals"),
      codeBlock("WHERE proxy_wallet = $1 AND condition_id = $2"),
      codeBlock("  AND detected_at >= to_timestamp($5) - INTERVAL '1 second'"),
      codeBlock("  AND detected_at <= to_timestamp($5) + INTERVAL '1 second'"),
      bodyText("Every detected signal is logged to an audit trail (copy_signals table), enabling both deduplication and post-hoc analysis of signal quality."),

      // ─── 4. Risk Controls ──────────────────────────────────────────
      sectionHeading("4. Paper Trading Risk Controls (7-Layer Filter)"),
      boldBodyText("Problem: ", "Unbounded position taking without safeguards could lead to excessive exposure and catastrophic losses."),
      boldBodyText("Solution: ", "Every copy signal must pass all 7 pre-flight checks before a position is opened:"),

      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [2800, 3280, 3280],
        rows: [
          new TableRow({ children: [
            headerCell("Filter", 2800),
            headerCell("Condition", 3280),
            headerCell("Purpose", 3280),
          ]}),
          new TableRow({ children: [
            bodyCell("Market Exists", 2800),
            bodyCell("Must be in tracked markets DB", 3280),
            bodyCell("Skip unknown/untracked markets", 3280),
          ]}),
          new TableRow({ children: [
            bodyCell("Market Active", 2800),
            bodyCell("Not closed or resolved", 3280),
            bodyCell("Don't trade dead markets", 3280),
          ]}),
          new TableRow({ children: [
            bodyCell("Time Buffer", 2800),
            bodyCell("Resolution >= N hours away", 3280),
            bodyCell("Avoid last-minute illiquidity", 3280),
          ]}),
          new TableRow({ children: [
            bodyCell("Price Cap", 2800),
            bodyCell("Price <= max threshold", 3280),
            bodyCell("Prevent overpaying (e.g., $0.70)", 3280),
          ]}),
          new TableRow({ children: [
            bodyCell("Position Limit", 2800),
            bodyCell("Open positions < max limit", 3280),
            bodyCell("Portfolio concentration cap", 3280),
          ]}),
          new TableRow({ children: [
            bodyCell("Daily Loss Limit", 2800),
            bodyCell("Realized losses < daily cap", 3280),
            bodyCell("Circuit breaker on losing days", 3280),
          ]}),
          new TableRow({ children: [
            bodyCell("No Duplicates", 2800),
            bodyCell("One position per market per target", 3280),
            bodyCell("Prevent double exposure", 3280),
          ]}),
        ],
      }),

      bodyText("Each failed filter logs a specific skip_reason to the audit trail for performance analysis."),

      // ─── 5. Graceful Shutdown ──────────────────────────────────────
      sectionHeading("5. Graceful Shutdown Handling"),
      boldBodyText("Problem: ", "Terminating the paper trading bot mid-cycle could leave the database in an inconsistent state (e.g., balance deducted but position not recorded)."),
      boldBodyText("Solution: ", "SIGINT/SIGTERM signal handlers set a flag that the main loop checks between operations."),
      codeBlock("process.on('SIGINT', () => { running = false; });"),
      codeBlock("process.on('SIGTERM', () => { running = false; });"),
      codeBlock("// Main loop checks 'running' between each operation"),
      bodyText("The bot completes the current cycle before exiting, ensuring all database operations are atomic and consistent."),

      // ─── 6. API Rate Limiting ──────────────────────────────────────
      sectionHeading("6. API Rate Limiting"),
      boldBodyText("Problem: ", "Polymarket APIs return HTTP 429 (Too Many Requests) when hit too rapidly, causing cascading failures during market scans."),
      boldBodyText("Solution: ", "Configurable delay between all paginated API requests (default 150-200ms)."),
      codeBlock("// Between every paginated API call"),
      codeBlock("await sleep(config.api.requestDelayMs);  // 150-200ms"),
      bodyText("The delay is applied consistently across Gamma (market catalog), Data (trade history), and CLOB (pricing) API clients."),

      // ─── 7. CLOB Price Fallback ────────────────────────────────────
      sectionHeading("7. CLOB Price Fallback"),
      boldBodyText("Problem: ", "Live midpoint pricing may be unavailable due to API errors, network issues, or illiquid markets, blocking position entry."),
      boldBodyText("Solution: ", "Graceful fallback to the source trade price when CLOB midpoint is unavailable."),
      codeBlock("let entryPrice = trade.price;  // default fallback"),
      codeBlock("try {"),
      codeBlock("  const mid = await getMidpoint(tokenId);"),
      codeBlock("  entryPrice = parseFloat(mid.mid) || trade.price;"),
      codeBlock("} catch { /* use trade price */ }"),
      bodyText("This ensures the bot can always enter positions even during API degradation, using the next-best price source."),

      // ─── 8. Migration Idempotency ──────────────────────────────────
      sectionHeading("8. Migration Idempotency"),
      boldBodyText("Problem: ", "Re-running database migrations (intentionally or accidentally) could corrupt the schema or cause duplicate data."),
      boldBodyText("Solution: ", "Multi-layer idempotency across all DDL and DML operations."),

      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "All CREATE TABLE/INDEX statements use IF NOT EXISTS", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Applied migrations tracked in _migrations table (never re-applied)", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Seed data uses ON CONFLICT DO NOTHING", font: "Arial", size: 20 })] }),

      bodyText("Migrations can be safely run multiple times across environments without side effects."),

      // ─── 9. Data Import Resumability ───────────────────────────────
      sectionHeading("9. Data Import Resumability"),
      boldBodyText("Problem: ", "Importing 19M+ trade records takes significant time. A crash midway would require restarting the entire import from scratch."),
      boldBodyText("Solution: ", "Each batch is independently committed, and all inserts use ON CONFLICT DO NOTHING."),

      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Each 500-row batch is its own transaction", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Completed batches persist even if the process crashes", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Re-running the import skips all previously inserted rows automatically", font: "Arial", size: 20 })] }),

      // ─── 10. SQL Injection Prevention ──────────────────────────────
      sectionHeading("10. SQL Injection Prevention"),
      boldBodyText("Problem: ", "Dynamic queries with user input are vulnerable to SQL injection attacks."),
      boldBodyText("Solution: ", "All database queries use parameterized placeholders ($1, $2, ...) throughout the entire codebase. No string interpolation is ever used in SQL statements."),
      codeBlock("// Every query is parameterized"),
      codeBlock("await query('SELECT * FROM traders WHERE proxy_wallet = $1', [wallet]);"),
      bodyText("This is enforced across all modules: API layer, services, CLI tools, MCP server, and dashboard."),

      // ─── 11. Live Trading Kill Switch ──────────────────────────────
      sectionHeading("11. Live Trading Kill Switch"),
      boldBodyText("Problem: ", "A runaway bot or market crash could cause the system to continue opening positions indefinitely with real funds."),
      boldBodyText("Solution: ", "Emergency kill switch that immediately closes all open live positions at entry price (break-even)."),
      codeBlock("async killSwitch(): Promise<void> {"),
      codeBlock("  const positions = await this.getOpenPositions();"),
      codeBlock("  for (const pos of positions) {"),
      codeBlock("    await this.closePosition(pos.id, pos.entry_price, 'kill_switch');"),
      codeBlock("  }"),
      codeBlock("}"),
      bodyText("The kill switch is accessible via both the CLI and the MCP server (execute tier only, requires explicit user approval)."),

      // ─── 12. MCP Tiered Access Control ─────────────────────────────
      sectionHeading("12. MCP Tiered Access Control"),
      boldBodyText("Problem: ", "External AI agents (e.g., OpenClaw) connecting via MCP could inadvertently execute dangerous operations like starting live trading or modifying risk parameters."),
      boldBodyText("Solution: ", "Three-tier permission system enforced at the server level."),

      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [1800, 3780, 3780],
        rows: [
          new TableRow({ children: [
            headerCell("Tier", 1800),
            headerCell("Permissions", 3780),
            headerCell("Example Tools", 3780),
          ]}),
          new TableRow({ children: [
            bodyCell("Read", 1800),
            bodyCell("View reports, metrics, positions", 3780),
            bodyCell("get_status, get_leaderboard, get_positions", 3780),
          ]}),
          new TableRow({ children: [
            bodyCell("Write", 1800),
            bodyCell("Add/remove targets, run backtests", 3780),
            bodyCell("add_target, remove_target, run_backtest", 3780),
          ]}),
          new TableRow({ children: [
            bodyCell("Execute", 1800),
            bodyCell("Start/stop trading, kill switch", 3780),
            bodyCell("start_trading, kill_switch (requires approval)", 3780),
          ]}),
        ],
      }),

      codeBlock("const TIER_LEVELS = { read: 1, write: 2, execute: 3 };"),
      codeBlock("function hasAccess(required) {"),
      codeBlock("  return TIER_LEVELS[ACCESS_TIER] >= TIER_LEVELS[required];"),
      codeBlock("}"),
      bodyText("Default tier is read-only. Execute-tier tools return a confirmation prompt that must be relayed to the human operator before action is taken."),

      // ─── Page Break before Architecture section ────────────────────
      new Paragraph({ children: [new PageBreak()] }),

      // ─── 13. Monorepo Code Deduplication ───────────────────────────
      sectionHeading("13. Monorepo Architecture (89% Code Deduplication)"),
      boldBodyText("Problem: ", "The original OpenClaw implementation maintained two fully separate codebases (weather bot + sports bot) with 89% identical code. Bug fixes, scoring algorithm changes, and API updates had to be applied in both places, leading to drift and inconsistencies."),
      boldBodyText("Solution: ", "Unified monorepo with shared core engine and thin category plugins."),

      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [3120, 3120, 3120],
        rows: [
          new TableRow({ children: [
            headerCell("Metric", 3120),
            headerCell("Before (OpenClaw)", 3120),
            headerCell("After (Migration)", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Codebases to maintain", 3120),
            bodyCell("2 separate repos", 3120),
            bodyCell("1 unified monorepo", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Duplicated code", 3120),
            bodyCell("~8,500 lines (89%)", 3120),
            bodyCell("0 lines", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Adding a new category", 3120),
            bodyCell("Copy entire bot (~4,700 lines)", 3120),
            bodyCell("1 classifier file (~50 lines)", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Database instances", 3120),
            bodyCell("2 separate Postgres DBs", 3120),
            bodyCell("1 unified DB", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Cross-category trader analysis", 3120),
            bodyCell("Not possible", 3120),
            bodyCell("Built-in (shared traders table)", 3120),
          ]}),
        ],
      }),

      bodyText("Each category (weather, sports, crypto, politics) implements a single CategoryPlugin interface. The shared core handles all API integration, scoring, trading, and data management."),

      // ─── 14. Unified Database Schema ───────────────────────────────
      sectionHeading("14. Unified Database Schema"),
      boldBodyText("Problem: ", "The OpenClaw system used separate databases per category (polyweather on port 5433, polysports on port 5434). Traders active across categories could not be analyzed holistically, and deploying new categories required provisioning new database infrastructure."),
      boldBodyText("Solution: ", "Single PostgreSQL database with a category column on the events table. All 14 tables are shared."),

      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Traders who trade both weather and sports markets are automatically merged by proxy_wallet", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Cross-category alpha scoring identifies traders with edge across multiple domains", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "New categories require zero database changes \u2014 just insert rows with the new category value", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Single connection pool reduces operational overhead and connection management complexity", font: "Arial", size: 20 })] }),

      // ─── 15. LLM Token Optimization ────────────────────────────────
      sectionHeading("15. LLM Token Cost Reduction (Admin Dashboard)"),
      boldBodyText("Problem: ", "With the OpenClaw system, every status check, performance review, and trading update required an LLM conversation. Each query consumed API tokens: a status report cost ~2,000-5,000 tokens per request, and daily monitoring across two bots consumed significant credits."),
      boldBodyText("Solution: ", "Purpose-built Next.js admin dashboard that renders all metrics, positions, signals, and backtests in real-time without any LLM involvement."),

      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [3120, 3120, 3120],
        rows: [
          new TableRow({ children: [
            headerCell("Operation", 3120),
            headerCell("Before (LLM cost)", 3120),
            headerCell("After (Dashboard)", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Check trading status", 3120),
            bodyCell("~3,000 tokens per query", 3120),
            bodyCell("0 tokens (browser refresh)", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("View leaderboard", 3120),
            bodyCell("~5,000 tokens per query", 3120),
            bodyCell("0 tokens", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Daily monitoring (2 bots)", 3120),
            bodyCell("~30,000-50,000 tokens/day", 3120),
            bodyCell("0 tokens", 3120),
          ]}),
          new TableRow({ children: [
            bodyCell("Signal analysis", 3120),
            bodyCell("~4,000 tokens per query", 3120),
            bodyCell("0 tokens", 3120),
          ]}),
        ],
      }),

      bodyText("The dashboard includes 5 pages: Overview (equity, PnL, categories), Positions (open/closed), Traders (alpha leaderboard + copy targets), Signals (audit trail with skip reasons), and Backtests (historical simulation results)."),

      // ─── 16. Controlled AI Integration via MCP ─────────────────────
      sectionHeading("16. Controlled AI Integration via MCP Protocol"),
      boldBodyText("Problem: ", "The OpenClaw AI agent had unrestricted access to all system operations, including the ability to start trading, modify risk parameters, and execute destructive operations. Its inefficient context window usage also meant it could lose track of prior instructions mid-conversation."),
      boldBodyText("Solution: ", "Model Context Protocol (MCP) server with tiered access control. The AI agent connects through a well-defined API with explicit permission boundaries."),

      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Read tier (default): AI can only view reports and metrics \u2014 cannot modify anything", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Write tier: AI can add copy targets and trigger backtests, but cannot start trading", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Execute tier: AI can control trading operations, but critical actions (kill switch, start live) return confirmation prompts that require human approval", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Each tool call is stateless and scoped \u2014 no risk of the AI losing context and taking unintended actions", font: "Arial", size: 20 })] }),

      // ─── 17. Backtesting Before Live ───────────────────────────────
      sectionHeading("17. Backtesting Engine for Strategy Validation"),
      boldBodyText("Problem: ", "The OpenClaw system went directly from scoring to paper trading with no ability to simulate historical performance. Strategy changes could not be validated before deployment."),
      boldBodyText("Solution: ", "Built-in backtesting engine that replays historical trades from the database, applying the same copy-trading logic and risk controls."),

      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Configurable parameters: date range, category, initial balance, position size, alpha threshold", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Output metrics: total return, Sharpe ratio, max drawdown, win rate, per-trader breakdown", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Equity curve stored for dashboard visualization", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "All backtest runs persisted in backtest_runs table for historical comparison", font: "Arial", size: 20 })] }),

      bodyText("This enables data-driven decisions about which traders to copy, what risk parameters to use, and whether strategy changes improve performance before committing real capital."),

      // ─── 18. Paper-to-Live Trading Separation ──────────────────────
      sectionHeading("18. Paper-to-Live Trading Architecture"),
      boldBodyText("Problem: ", "Moving from paper trading to live trading in the OpenClaw system would require rewriting the trading logic, with risk of accidentally using the wrong mode."),
      boldBodyText("Solution: ", "Dual trading engines implementing the same interface, with separate database tables for paper and live positions."),

      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "paper_positions and live_positions are separate tables \u2014 impossible to accidentally mix", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "accounts table tracks paper and live balances independently", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Same signal detection and filtering logic drives both modes \u2014 paper results are a reliable predictor of live performance", font: "Arial", size: 20 })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Live engine includes additional safeguards: wallet balance checks, on-chain transaction tracking, and kill switch", font: "Arial", size: 20 })] }),

      // ─── 19. Comprehensive Audit Trail ─────────────────────────────
      sectionHeading("19. Comprehensive Audit Trail"),
      boldBodyText("Problem: ", "The OpenClaw system had limited visibility into why certain signals were acted on or skipped, making it difficult to diagnose performance issues."),
      boldBodyText("Solution: ", "Every signal, position, and scoring decision is logged with full context."),

      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [2340, 3510, 3510],
        rows: [
          new TableRow({ children: [
            headerCell("Table", 2340),
            headerCell("Records", 3510),
            headerCell("Key Fields", 3510),
          ]}),
          new TableRow({ children: [
            bodyCell("copy_signals", 2340),
            bodyCell("Every detected trader signal", 3510),
            bodyCell("acted_on, skip_reason, signal_type", 3510),
          ]}),
          new TableRow({ children: [
            bodyCell("paper_positions", 2340),
            bodyCell("Every opened/closed position", 3510),
            bodyCell("entry/exit price, PnL, close_reason", 3510),
          ]}),
          new TableRow({ children: [
            bodyCell("backtest_runs", 2340),
            bodyCell("Every simulation run", 3510),
            bodyCell("config, equity_curve, per_trader", 3510),
          ]}),
          new TableRow({ children: [
            bodyCell("scan_progress", 2340),
            bodyCell("Every market scan", 3510),
            bodyCell("trades_fetched, traders_found", 3510),
          ]}),
        ],
      }),

      bodyText("This audit trail enables root cause analysis, strategy refinement, and regulatory compliance documentation."),

      // ─── 20. Scalable Category Plugin System ───────────────────────
      sectionHeading("20. Scalable Category Plugin System"),
      boldBodyText("Problem: ", "Adding cryptocurrency, politics, or entertainment prediction markets to the OpenClaw system would require duplicating the entire codebase again, multiplying maintenance burden."),
      boldBodyText("Solution: ", "Category plugin interface that allows new market domains to be added with minimal code."),

      codeBlock("interface CategoryPlugin {"),
      codeBlock("  name: string;                    // 'weather', 'sports', 'crypto'"),
      codeBlock("  tags: string[];                  // Polymarket tags to match"),
      codeBlock("  keywords: Record<string, string[]>;"),
      codeBlock("  blacklist: string[];"),
      codeBlock("  classifyEvent(event): ClassifiedEvent | null;"),
      codeBlock("  isMatchingEvent(event): boolean;"),
      codeBlock("}"),

      bodyText("Adding a new category (e.g., cryptocurrency markets) requires: (1) a classifier file defining how to identify and categorize events, (2) a config file with tags/keywords, and (3) registering the plugin. All scoring, trading, backtesting, dashboard, and MCP functionality works automatically with the new category."),
    ],
  }],
});

Packer.toBuffer(doc).then(buffer => {
  const outPath = '/Users/apple/Documents/Active Development/MO/Polymarket-Bot/Code_Hardening_PPM.docx';
  fs.writeFileSync(outPath, buffer);
  console.log('Document created:', outPath);
});
