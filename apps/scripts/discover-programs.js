#!/usr/bin/env node

/**
 * GitHub Discovery Script for FundingFinder
 *
 * This script:
 * 1. Reads trusted funding sources from data/funding-sources.json
 * 2. Visits each source URL
 * 3. Detects if it's a directory/list page or detail page
 * 4. Extracts all program links from directory pages
 * 5. Visits each program detail page
 * 6. Extracts comprehensive program information
 * 7. Sends draft programs to POST /api/import-programs
 *
 * Environment Variables Required:
 * - IMPORT_PROGRAMS_SECRET: Bearer token for authentication
 * - ANYTHING_IMPORT_URL: Import endpoint URL (e.g., https://yourdomain.com/api/import-programs)
 * - DISCOVERY_PRIORITY: Priority filter (high, medium, low, all) - defaults to "high"
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
const MAX_PROGRAM_LINKS = 100;
const FETCH_TIMEOUT = 15000; // 15 seconds
const RATE_LIMIT_DELAY = 1000; // 1 second between requests

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

// Helper to fetch URL content with timeout
async function fetchURL(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "FundingFinder-Discovery-Bot/1.0 (https://github.com/fundingfinder)",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  } catch (error) {
    if (error.name === "AbortError") {
      console.error(`   ⏱️  Timeout fetching ${url} (${FETCH_TIMEOUT}ms)`);
    } else {
      console.error(`   ❌ Failed to fetch ${url}:`, error.message);
    }
    return null;
  }
}

// Convert relative URL to absolute
function toAbsoluteURL(href, baseUrl) {
  if (!href) return null;

  try {
    // Already absolute
    if (href.startsWith("http://") || href.startsWith("https://")) {
      return href;
    }

    // Relative to root
    if (href.startsWith("/")) {
      const base = new URL(baseUrl);
      return `${base.protocol}//${base.host}${href}`;
    }

    // Relative to current path
    return new URL(href, baseUrl).toString();
  } catch (error) {
    return null;
  }
}

// Check if URL should be skipped
function shouldSkipLink(url, baseUrl, linkText) {
  if (!url) return true;

  const lowerUrl = url.toLowerCase();
  const lowerText = (linkText || "").toLowerCase();

  // Skip anchors
  if (url.startsWith("#")) return true;

  // Skip mailto/tel/javascript
  if (
    lowerUrl.startsWith("mailto:") ||
    lowerUrl.startsWith("tel:") ||
    lowerUrl.startsWith("javascript:")
  )
    return true;

  // Skip social media
  if (
    lowerUrl.includes("facebook.com") ||
    lowerUrl.includes("twitter.com") ||
    lowerUrl.includes("linkedin.com") ||
    lowerUrl.includes("instagram.com") ||
    lowerUrl.includes("youtube.com")
  )
    return true;

  // Skip PDFs and documents
  if (
    lowerUrl.endsWith(".pdf") ||
    lowerUrl.endsWith(".doc") ||
    lowerUrl.endsWith(".docx") ||
    lowerUrl.endsWith(".xls") ||
    lowerUrl.endsWith(".xlsx")
  )
    return true;

  // Skip navigation/footer links
  const skipTexts = [
    "home",
    "about",
    "contact",
    "privacy",
    "terms",
    "login",
    "sign in",
    "register",
    "logout",
    "sitemap",
    "accessibility",
  ];
  if (skipTexts.some((skip) => lowerText === skip)) return true;

  // Must be same domain
  try {
    const urlDomain = new URL(url).hostname;
    const baseDomain = new URL(baseUrl).hostname;
    if (urlDomain !== baseDomain) return true;
  } catch {
    return true;
  }

  return false;
}

// Detect if page is a directory/list page
function isDirectoryPage(html, url) {
  // Count links that look like programs
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let programLinkCount = 0;
  let match;

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

  while ((match = linkRegex.exec(html)) !== null) {
    const text = match[2]
      .replace(/<[^>]+>/g, "")
      .trim()
      .toLowerCase();
    if (fundingKeywords.some((keyword) => text.includes(keyword))) {
      programLinkCount++;
    }
  }

  // If page has many program-like links, it's likely a directory
  const isDirectory = programLinkCount >= 5;

  console.log(
    `   🔎 Page analysis: ${programLinkCount} program-like links found → ${isDirectory ? "DIRECTORY" : "DETAIL"} page`,
  );

  return isDirectory;
}

// Extract all program links from a directory page
function extractProgramLinks(html, baseUrl) {
  const links = [];
  const seenUrls = new Set();

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

  // Check if this is a Nova Scotia programs directory page
  const isNovaScotiaProgramsDir =
    baseUrl.includes("novascotia.ca") && baseUrl.includes("/programs");

  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, "").trim();
    const lowerText = text.toLowerCase();

    let shouldInclude = false;

    // Special handling for Nova Scotia programs directory
    if (isNovaScotiaProgramsDir) {
      const fullUrl = toAbsoluteURL(href, baseUrl);

      // Include if URL starts with /programs/ and meets basic criteria
      if (fullUrl && fullUrl.includes("/programs/")) {
        try {
          const urlPath = new URL(fullUrl).pathname;

          // Must start with /programs/
          if (urlPath.startsWith("/programs/")) {
            // Must not be exactly /programs/
            if (urlPath !== "/programs/" && urlPath !== "/programs") {
              // Must have non-empty link text
              if (text.length > 0) {
                // Check it's not a PDF, email, social, login, or anchor
                const lowerUrl = fullUrl.toLowerCase();
                const isPdf = lowerUrl.endsWith(".pdf");
                const isEmail = lowerUrl.startsWith("mailto:");
                const isSocial =
                  lowerUrl.includes("facebook.com") ||
                  lowerUrl.includes("twitter.com") ||
                  lowerUrl.includes("linkedin.com");
                const isLogin =
                  lowerText.includes("login") || lowerText.includes("sign in");
                const isAnchor = href.startsWith("#");

                if (!isPdf && !isEmail && !isSocial && !isLogin && !isAnchor) {
                  shouldInclude = true;
                }
              }
            }
          }
        } catch (e) {
          // Invalid URL, skip
        }
      }
    } else {
      // Normal keyword-based filtering for other sources
      const containsFundingKeyword = fundingKeywords.some((keyword) =>
        lowerText.includes(keyword),
      );
      shouldInclude = containsFundingKeyword;
    }

    if (shouldInclude) {
      const fullUrl = toAbsoluteURL(href, baseUrl);

      if (shouldSkipLink(fullUrl, baseUrl, text)) {
        continue;
      }

      if (seenUrls.has(fullUrl)) {
        continue;
      }

      seenUrls.add(fullUrl);
      links.push({
        url: fullUrl,
        text: text,
      });

      // Limit to MAX_PROGRAM_LINKS
      if (links.length >= MAX_PROGRAM_LINKS) {
        console.log(
          `   ⚠️  Reached max limit of ${MAX_PROGRAM_LINKS} program links`,
        );
        break;
      }
    }
  }

  return links;
}

// Extract program information from a detail page
function extractProgramInfo(html, sourceUrl, sourceName, defaultProvince) {
  const program = {
    source_url: sourceUrl,
    source_name: sourceName,
    import_method: "github_discovery",
  };

  // Extract name from h1
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) {
    program.name = h1Match[1].trim().substring(0, 200);
  } else {
    // Fallback to title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      program.name = titleMatch[1].trim().substring(0, 200);
    }
  }

  // Extract description from meta description or first paragraph
  const metaMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  );
  if (metaMatch) {
    program.description = metaMatch[1].trim().substring(0, 500);
  } else {
    // Try first paragraph near h1
    const pMatch = html.match(/<h1[^>]*>.*?<\/h1>\s*<p[^>]*>([^<]+)<\/p>/is);
    if (pMatch) {
      program.description = pMatch[1].trim().substring(0, 500);
    } else {
      const anyPMatch = html.match(/<p[^>]*>([^<]+)<\/p>/i);
      if (anyPMatch) {
        program.description = anyPMatch[1].trim().substring(0, 500);
      }
    }
  }

  const text = html.replace(/<[^>]+>/g, " ");
  const lowerText = text.toLowerCase();

  // Extract eligibility
  const eligibilityMatch = text.match(
    /(?:eligibility|who can apply)[:\s]+([\s\S]{0,500}?)(?:\n\n|<h\d|$)/i,
  );
  if (eligibilityMatch) {
    program.eligibility = eligibilityMatch[1].trim().substring(0, 500);
  }

  // Extract how to apply
  const applyMatch = text.match(
    /(?:how to apply|application process)[:\s]+([\s\S]{0,500}?)(?:\n\n|<h\d|$)/i,
  );
  if (applyMatch) {
    program.how_to_apply = applyMatch[1].trim().substring(0, 500);
  }

  // Extract program type
  if (lowerText.includes("grant") && !lowerText.includes("loan")) {
    program.program_type = "Grant";
  } else if (lowerText.includes("loan")) {
    program.program_type = "Loan";
  } else if (lowerText.includes("tax credit")) {
    program.program_type = "Tax Credit";
  } else if (lowerText.includes("subsidy")) {
    program.program_type = "Subsidy";
  } else if (lowerText.includes("rebate")) {
    program.program_type = "Rebate";
  }

  // Extract funding amount patterns
  const amountMatch = lowerText.match(
    /(?:up to|maximum|max of)?\s*\$[\d,]+(?:k|m|,\d{3})*(?:\s*(?:million|thousand))?/i,
  );
  if (amountMatch) {
    program.funding_amount = amountMatch[0].trim();
  }

  // Extract application link
  const applyLinkMatch = html.match(
    /<a[^>]+href=["']([^"']+)["'][^>]*>\s*(?:apply|application|submit|register|apply now|start application)/i,
  );
  if (applyLinkMatch) {
    program.application_link = toAbsoluteURL(applyLinkMatch[1], sourceUrl);
  }

  // Extract deadline
  const deadlineMatch = text.match(
    /(?:deadline|apply by|due date)[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
  );
  if (deadlineMatch) {
    program.deadline = deadlineMatch[1];
  }

  // Set province
  if (defaultProvince && defaultProvince !== "National") {
    program.province = defaultProvince;
  }

  return program;
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

  // Detect if this is a directory or detail page
  const isDirectory = isDirectoryPage(html, source.url);

  const programs = [];
  const visitedUrls = new Set();

  if (isDirectory) {
    // Extract all program links
    const programLinks = extractProgramLinks(html, source.url);
    console.log(`   📋 Found ${programLinks.length} program links`);

    // Visit each program detail page
    for (let i = 0; i < programLinks.length; i++) {
      const link = programLinks[i];

      if (visitedUrls.has(link.url)) {
        console.log(`   ⏭️  Skipped duplicate: ${link.text}`);
        continue;
      }

      visitedUrls.add(link.url);

      console.log(
        `   📄 [${i + 1}/${programLinks.length}] Visiting: ${link.text}`,
      );
      console.log(`      ${link.url}`);

      const programHtml = await fetchURL(link.url);
      if (!programHtml) {
        console.log(`      ❌ Failed to fetch`);
        continue;
      }

      const programInfo = extractProgramInfo(
        programHtml,
        link.url,
        source.name,
        source.province,
      );

      if (programInfo.name) {
        programs.push(programInfo);
        console.log(`      ✅ Extracted: ${programInfo.name}`);
      } else {
        console.log(`      ⚠️  No program name found, skipping`);
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
    }
  } else {
    // This is a detail page - extract directly
    console.log(`   📄 Processing detail page`);

    const programInfo = extractProgramInfo(
      html,
      source.url,
      source.name,
      source.province,
    );

    if (programInfo.name) {
      programs.push(programInfo);
      console.log(`   ✅ Extracted: ${programInfo.name}`);
    } else {
      console.log(`   ⚠️  No program name found`);
    }
  }

  console.log(`   ✨ Total extracted: ${programs.length} programs`);
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
    console.log(`📚 Loaded ${sources.length} total funding sources`);
  } catch (error) {
    console.error("❌ Failed to load funding sources:", error.message);
    process.exit(1);
  }

  // Filter by priority from environment variable
  const selectedPriority = process.env.DISCOVERY_PRIORITY || "high";
  const sourcesToProcess =
    selectedPriority === "all"
      ? sources
      : sources.filter((s) => s.priority === selectedPriority);

  console.log(`🎯 Priority filter: "${selectedPriority}"`);
  console.log(
    `📋 Processing ${sourcesToProcess.length} sources (${sources.length} total available)\n`,
  );

  if (sourcesToProcess.length === 0) {
    console.log(
      `⚠️  No sources found with priority "${selectedPriority}". Exiting.`,
    );
    return;
  }

  // Discover programs from each source
  const allPrograms = [];

  for (const source of sourcesToProcess) {
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
