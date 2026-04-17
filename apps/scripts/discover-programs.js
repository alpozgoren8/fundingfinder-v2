#!/usr/bin/env node

/**
 * GitHub Discovery Script for FundingFinder
 *
 * This script:
 * 1. Reads trusted funding sources from data/funding-sources.json
 * 2. Visits each source URL
 * 3. Finds funding program links (grants, loans, tax credits, subsidies, incentives)
 * 4. Extracts program information
 * 5. Sends draft programs to POST /api/import-programs
 *
 * Environment Variables Required:
 * - IMPORT_PROGRAMS_SECRET: Bearer token for authentication
 * - ANYTHING_IMPORT_URL: Import endpoint URL (e.g., https://yourdomain.com/api/import-programs)
 */

const fs = require("fs").promises;
const path = require("path");

// Configuration
const IMPORT_URL = process.env.ANYTHING_IMPORT_URL;
const IMPORT_SECRET = process.env.IMPORT_PROGRAMS_SECRET;
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
  "all provinces": "National",
};

// Helper to normalize province names to codes
function normalizeProvince(provinceName) {
  if (!provinceName) return null;
  const normalized = provinceName.toLowerCase().trim();
  return PROVINCE_MAPPINGS[normalized] || provinceName;
}

// Helper to fetch URL content
async function fetchURL(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "FundingFinder-Discovery-Bot/1.0 (https://github.com/fundingfinder)",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  } catch (error) {
    console.error(`Failed to fetch ${url}:`, error.message);
    return null;
  }
}

// Extract potential program links from HTML
function extractProgramLinks(html, baseUrl) {
  const links = [];

  // Keywords that indicate funding programs
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
    "contribution",
    "investment",
    "capital",
    "rebate",
    "benefit",
  ];

  // Simple regex to extract links (in production, use a proper HTML parser)
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, "").trim();

    // Check if link text contains funding keywords
    const lowerText = text.toLowerCase();
    const containsFundingKeyword = fundingKeywords.some((keyword) =>
      lowerText.includes(keyword),
    );

    if (containsFundingKeyword && href) {
      // Resolve relative URLs
      let fullUrl = href;
      if (href.startsWith("/")) {
        const base = new URL(baseUrl);
        fullUrl = `${base.protocol}//${base.host}${href}`;
      } else if (!href.startsWith("http")) {
        fullUrl = new URL(href, baseUrl).toString();
      }

      links.push({
        url: fullUrl,
        text: text,
      });
    }
  }

  return links;
}

// Extract program information from a page (simplified version)
// In production, you would use AI/LLM to extract structured data
function extractProgramInfo(html, sourceUrl, sourceName) {
  // This is a simplified extraction - in production, use AI (GPT/Claude) to extract structured data
  const program = {
    name: extractTitle(html) || "Discovered Program",
    description:
      extractDescription(html) || "Program description pending review",
    source_url: sourceUrl,
    source_name: sourceName,
    import_method: "github_discovery",
  };

  // Try to extract other fields
  const text = html.replace(/<[^>]+>/g, " ").toLowerCase();

  // Extract program type
  if (text.includes("grant") && !text.includes("loan")) {
    program.program_type = "Grant";
  } else if (text.includes("loan")) {
    program.program_type = "Loan";
  } else if (text.includes("tax credit")) {
    program.program_type = "Tax Credit";
  } else if (text.includes("subsidy")) {
    program.program_type = "Subsidy";
  }

  // Extract funding amount patterns (e.g., "$50,000", "up to $1M")
  const amountMatch = text.match(
    /\$[\d,]+(?:k|m)?|\d+(?:,\d{3})*\s*(?:dollars?|cad)/i,
  );
  if (amountMatch) {
    program.funding_amount = amountMatch[0];
  }

  // Extract application link
  const applyLinkMatch = html.match(
    /<a[^>]+href=["']([^"']+)["'][^>]*>(?:apply|application|submit|register)/i,
  );
  if (applyLinkMatch) {
    program.application_link = applyLinkMatch[1];
  }

  return program;
}

function extractTitle(html) {
  // Try to extract page title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    return titleMatch[1].trim().substring(0, 200);
  }

  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) {
    return h1Match[1].trim().substring(0, 200);
  }

  return null;
}

function extractDescription(html) {
  // Try to extract meta description
  const metaMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  );
  if (metaMatch) {
    return metaMatch[1].trim().substring(0, 500);
  }

  // Try first paragraph
  const pMatch = html.match(/<p[^>]*>([^<]+)<\/p>/i);
  if (pMatch) {
    return pMatch[1].trim().substring(0, 500);
  }

  return null;
}

// Discover programs from a single source
async function discoverFromSource(source) {
  console.log(`\n🔍 Discovering from: ${source.name}`);
  console.log(`   URL: ${source.url}`);

  const html = await fetchURL(source.url);
  if (!html) {
    console.log(`   ❌ Failed to fetch content`);
    return [];
  }

  // Extract program links
  const programLinks = extractProgramLinks(html, source.url);
  console.log(`   📋 Found ${programLinks.length} potential program links`);

  const programs = [];

  // Limit to first 5 links per source to avoid overwhelming the system
  const linksToProcess = programLinks.slice(0, 5);

  for (const link of linksToProcess) {
    console.log(`   📄 Processing: ${link.text}`);

    const programHtml = await fetchURL(link.url);
    if (!programHtml) {
      continue;
    }

    const programInfo = extractProgramInfo(programHtml, link.url, source.name);

    // Add source province if available
    if (source.province && source.province !== "National") {
      programInfo.province = source.province;
    }

    programs.push(programInfo);

    // Rate limiting - wait 1 second between requests
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log(`   ✅ Extracted ${programs.length} programs`);
  return programs;
}

// Send programs to import API
async function importPrograms(programs) {
  if (!IMPORT_URL || !IMPORT_SECRET) {
    console.error("\n❌ Missing required environment variables:");
    console.error("   ANYTHING_IMPORT_URL:", IMPORT_URL ? "✓" : "✗");
    console.error("   IMPORT_PROGRAMS_SECRET:", IMPORT_SECRET ? "✓" : "✗");
    process.exit(1);
  }

  console.log(`\n📤 Sending ${programs.length} programs to import API...`);

  try {
    const response = await fetch(IMPORT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${IMPORT_SECRET}`,
      },
      body: JSON.stringify({
        programs: programs,
        import_method: "github_discovery",
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("❌ Import failed:", result);
      return;
    }

    console.log("\n✅ Import complete!");
    console.log(`   Total: ${result.total}`);
    console.log(`   Inserted: ${result.inserted}`);
    console.log(`   Skipped: ${result.skipped}`);

    if (result.errors && result.errors.length > 0) {
      console.log(`   Errors: ${result.errors.length}`);
      result.errors.forEach((err) => {
        console.log(`     - ${err.program}: ${err.error}`);
      });
    }

    if (result.skipped_programs && result.skipped_programs.length > 0) {
      console.log(`\n   Skipped programs (duplicates):`);
      result.skipped_programs.forEach((skip) => {
        console.log(`     - ${skip.program}: ${skip.reason}`);
      });
    }

    return result;
  } catch (error) {
    console.error("\n❌ Import request failed:", error.message);
  }
}

// Main execution
async function main() {
  console.log("🚀 FundingFinder GitHub Discovery Bot");
  console.log("=====================================\n");

  // Load funding sources
  let sources;
  try {
    const sourcesJson = await fs.readFile(FUNDING_SOURCES_PATH, "utf-8");
    sources = JSON.parse(sourcesJson);
    console.log(`📚 Loaded ${sources.length} funding sources`);
  } catch (error) {
    console.error("❌ Failed to load funding sources:", error.message);
    process.exit(1);
  }

  // Filter to high priority sources only for weekly runs
  const highPrioritySources = sources.filter((s) => s.priority === "high");
  console.log(
    `🎯 Processing ${highPrioritySources.length} high-priority sources\n`,
  );

  // Discover programs from each source
  const allPrograms = [];

  for (const source of highPrioritySources) {
    const programs = await discoverFromSource(source);
    allPrograms.push(...programs);

    // Wait between sources to be respectful
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log(`\n📊 Total programs discovered: ${allPrograms.length}`);

  if (allPrograms.length === 0) {
    console.log("ℹ️  No programs discovered. Exiting.");
    return;
  }

  // Import discovered programs
  await importPrograms(allPrograms);

  console.log("\n✨ Discovery complete!");
}

// Run the script
main().catch((error) => {
  console.error("\n💥 Fatal error:", error);
  process.exit(1);
});
