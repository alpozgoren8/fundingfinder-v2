#!/usr/bin/env node

/**
 * Test Discovery Script
 *
 * Use this script to test program discovery locally before running via GitHub Actions.
 * This script will discover programs but NOT import them - it just shows what would be discovered.
 */

const fs = require("fs").promises;
const path = require("path");

const FUNDING_SOURCES_PATH = path.join(
  __dirname,
  "../data/funding-sources.json",
);

// Province code mapping for normalization
const PROVINCE_MAPPINGS = {
  ontario: "ON",
  quebec: "QC",
  "british columbia": "BC",
  alberta: "AB",
  manitoba: "MB",
  saskatchewan: "SK",
  "nova scotia": "NS",
  "new brunswick": "NB",
  "newfoundland and labrador": "NL",
  "prince edward island": "PE",
  "northwest territories": "NT",
  nunavut: "NU",
  yukon: "YT",
  canada: "National",
  national: "National",
  federal: "National",
};

function normalizeProvince(provinceName) {
  if (!provinceName) return null;
  const normalized = provinceName.toLowerCase().trim();
  return PROVINCE_MAPPINGS[normalized] || provinceName;
}

async function fetchURL(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "FundingFinder-Test/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    return null;
  }
}

function extractProgramLinks(html, baseUrl) {
  const links = [];
  const fundingKeywords = [
    "grant",
    "loan",
    "funding",
    "subsidy",
    "credit",
    "incentive",
    "program",
    "finance",
    "support",
    "assistance",
  ];

  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, "").trim();
    const lowerText = text.toLowerCase();

    if (fundingKeywords.some((k) => lowerText.includes(k)) && href) {
      let fullUrl = href;
      if (href.startsWith("/")) {
        const base = new URL(baseUrl);
        fullUrl = `${base.protocol}//${base.host}${href}`;
      } else if (!href.startsWith("http")) {
        fullUrl = new URL(href, baseUrl).toString();
      }

      links.push({ url: fullUrl, text });
    }
  }

  return links;
}

function extractTitle(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) return titleMatch[1].trim();

  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) return h1Match[1].trim();

  return "Unknown Program";
}

function extractDescription(html) {
  const metaMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  );
  if (metaMatch) return metaMatch[1].trim();

  const pMatch = html.match(/<p[^>]*>([^<]+)<\/p>/i);
  if (pMatch) return pMatch[1].trim();

  return "Description not available";
}

function extractProgramType(html) {
  const text = html.toLowerCase();
  if (text.includes("grant") && !text.includes("loan")) return "Grant";
  if (text.includes("loan")) return "Loan";
  if (text.includes("tax credit")) return "Tax Credit";
  if (text.includes("subsidy")) return "Subsidy";
  return null;
}

function extractFundingAmount(html) {
  const text = html.toLowerCase();
  const match = text.match(
    /\$[\d,]+(?:k|m)?|\d+(?:,\d{3})*\s*(?:dollars?|cad)/i,
  );
  return match ? match[0] : null;
}

async function testSource(source, maxLinks = 3) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`📍 Testing: ${source.name}`);
  console.log(`   URL: ${source.url}`);
  console.log(
    `   Type: ${source.type} | Province: ${source.province} | Priority: ${source.priority}`,
  );
  console.log(`${"=".repeat(80)}\n`);

  // Fetch homepage
  console.log("🌐 Fetching homepage...");
  const html = await fetchURL(source.url);

  if (!html) {
    console.log("❌ Failed to fetch homepage\n");
    return [];
  }

  console.log(`✅ Fetched ${(html.length / 1024).toFixed(1)} KB\n`);

  // Extract links
  console.log("🔗 Extracting program links...");
  const links = extractProgramLinks(html, source.url);
  console.log(`   Found ${links.length} potential links\n`);

  if (links.length === 0) {
    console.log("⚠️  No program links found\n");
    return [];
  }

  // Show first few links
  console.log("📋 Sample links:");
  links.slice(0, 5).forEach((link, i) => {
    console.log(`   ${i + 1}. ${link.text}`);
    console.log(
      `      ${link.url.substring(0, 80)}${link.url.length > 80 ? "..." : ""}`,
    );
  });
  console.log("");

  // Extract program details from first few links
  const programs = [];
  const linksToProcess = links.slice(0, maxLinks);

  console.log(
    `🔍 Extracting details from ${linksToProcess.length} programs...\n`,
  );

  for (const [index, link] of linksToProcess.entries()) {
    console.log(`   [${index + 1}/${linksToProcess.length}] ${link.text}...`);

    const programHtml = await fetchURL(link.url);
    if (!programHtml) {
      console.log(`       ❌ Failed to fetch\n`);
      continue;
    }

    const program = {
      name: extractTitle(programHtml),
      description: extractDescription(programHtml),
      program_type: extractProgramType(programHtml),
      funding_amount: extractFundingAmount(programHtml),
      source_url: link.url,
      source_name: source.name,
      province: source.province !== "National" ? source.province : null,
      import_method: "github_discovery",
    };

    programs.push(program);

    console.log(
      `       ✅ Extracted: ${program.name.substring(0, 50)}${program.name.length > 50 ? "..." : ""}`,
    );
    console.log(`          Type: ${program.program_type || "Unknown"}`);
    console.log(
      `          Amount: ${program.funding_amount || "Not specified"}\n`,
    );

    // Rate limiting
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return programs;
}

async function main() {
  console.log("\n🧪 FundingFinder Discovery Test");
  console.log("================================\n");

  // Load sources
  let sources;
  try {
    const json = await fs.readFile(FUNDING_SOURCES_PATH, "utf-8");
    sources = JSON.parse(json);
  } catch (error) {
    console.error("❌ Failed to load funding sources:", error.message);
    process.exit(1);
  }

  // Get test mode from arguments
  const args = process.argv.slice(2);
  const testMode = args[0] || "single"; // single, high, all

  let sourcesToTest;
  if (testMode === "single") {
    sourcesToTest = sources.slice(0, 1);
    console.log(`📍 Testing single source (first in list)\n`);
  } else if (testMode === "high") {
    sourcesToTest = sources.filter((s) => s.priority === "high");
    console.log(
      `📍 Testing all high-priority sources (${sourcesToTest.length} sources)\n`,
    );
  } else {
    sourcesToTest = sources;
    console.log(`📍 Testing ALL sources (${sourcesToTest.length} sources)\n`);
  }

  if (sourcesToTest.length === 0) {
    console.log("❌ No sources to test\n");
    return;
  }

  // Test each source
  const allPrograms = [];

  for (const source of sourcesToTest) {
    const programs = await testSource(source, 3);
    allPrograms.push(...programs);

    // Wait between sources
    if (sourcesToTest.length > 1) {
      console.log("⏳ Waiting 2 seconds before next source...\n");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Summary
  console.log(`\n${"=".repeat(80)}`);
  console.log("📊 DISCOVERY SUMMARY");
  console.log(`${"=".repeat(80)}\n`);
  console.log(`Sources tested: ${sourcesToTest.length}`);
  console.log(`Programs discovered: ${allPrograms.length}\n`);

  if (allPrograms.length > 0) {
    console.log("Program breakdown:");
    const byType = {};
    allPrograms.forEach((p) => {
      const type = p.program_type || "Unknown";
      byType[type] = (byType[type] || 0) + 1;
    });
    Object.entries(byType).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    console.log("\n📝 Sample programs:\n");
    allPrograms.slice(0, 5).forEach((p, i) => {
      console.log(`${i + 1}. ${p.name}`);
      console.log(
        `   Type: ${p.program_type || "Unknown"} | Amount: ${p.funding_amount || "N/A"}`,
      );
      console.log(`   Source: ${p.source_name}`);
      console.log(`   URL: ${p.source_url.substring(0, 70)}...\n`);
    });

    // Save to file
    const outputPath = path.join(__dirname, "test-output.json");
    await fs.writeFile(outputPath, JSON.stringify(allPrograms, null, 2));
    console.log(`\n💾 Full results saved to: ${outputPath}\n`);
  }

  console.log("✨ Test complete!\n");
  console.log("💡 Next steps:");
  console.log("   1. Review the extracted programs above");
  console.log("   2. Check test-output.json for full details");
  console.log(
    "   3. Adjust extraction logic in discover-programs.js if needed",
  );
  console.log(
    "   4. Run the full discovery with: node scripts/discover-programs.js\n",
  );
}

main().catch((error) => {
  console.error("\n💥 Test failed:", error);
  process.exit(1);
});
