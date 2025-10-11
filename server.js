import express from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Allowed origins
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://vektor-insight.vercel.app",
  "https://studymate-swart.vercel.app",
];
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// Multiple Gemini API keys for load balancing
const GEMINI_API_KEYS = [
  process.env.GEMINI_API_KEY_1 || "AIzaSyCk3VyHVj3_UMqtHlN5NhbS5pv9yMHDSTs",
  process.env.GEMINI_API_KEY_2 || "AIzaSyD8_ir9uyfEB2vTlyc7D2X5EWYwQRnjGt4", // Add your second API key
];

// API usage tracker
let apiUsage = GEMINI_API_KEYS.map(() => ({ 
  requests: 0, 
  lastReset: Date.now(),
  errors: 0 
}));

// Middleware
app.use(express.json());
app.use(express.static("public"));

// ------------------- PATHS -------------------
const BASE_TMP = "/tmp";
const UPLOADS_PATH = path.join(BASE_TMP, "uploads");
const EXTRACTED_PATH = path.join(BASE_TMP, "extracted");
const REPOS_PATH = path.join(BASE_TMP, "repos");
[UPLOADS_PATH, EXTRACTED_PATH, REPOS_PATH].forEach((p) =>
  fs.mkdirSync(p, { recursive: true })
);

// ------------------- MULTER -------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_PATH);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

// ------------------- HELPERS -------------------
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reset API usage every hour
function resetApiUsage() {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  apiUsage.forEach((usage, index) => {
    if (now - usage.lastReset > oneHour) {
      apiUsage[index] = { requests: 0, lastReset: now, errors: 0 };
      console.log(`🔄 Reset API ${index + 1} usage`);
    }
  });
}

// Smart API key selection with load balancing
function getBestApiKey() {
  resetApiUsage();
  
  // Find API with least recent usage and errors
  const sortedApis = apiUsage
    .map((usage, index) => ({ ...usage, index }))
    .sort((a, b) => {
      // Prioritize APIs with fewer errors
      if (a.errors !== b.errors) return a.errors - b.errors;
      // Then by fewer requests
      return a.requests - b.requests;
    });

  const bestApi = sortedApis[0];
  apiUsage[bestApi.index].requests++;
  
  console.log(`🔑 Using API ${bestApi.index + 1} (Requests: ${bestApi.requests}, Errors: ${bestApi.errors})`);
  return {
    key: GEMINI_API_KEYS[bestApi.index],
    index: bestApi.index
  };
}

// Mark API as having error
function markApiError(apiIndex) {
  if (apiIndex >= 0 && apiIndex < apiUsage.length) {
    apiUsage[apiIndex].errors++;
    console.log(`❌ Marked API ${apiIndex + 1} with error (Total errors: ${apiUsage[apiIndex].errors})`);
  }
}

const LANGUAGE_EXTENSIONS = {
  python: [".py"],
  javascript: [".js", ".jsx"],
  typescript: [".ts", ".tsx"],
  java: [".java"],
  c: [".c"],
  cpp: [".cpp", ".cc", ".cxx", ".c++"],
  php: [".php"],
};

const DEPENDENCY_FILES = [
  "package.json",
  "requirements.txt",
  "Pipfile",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "go.mod",
  "go.sum",
];

// Files to ignore completely
const IGNORE_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];

function detectLanguage(filename) {
  const ext = path.extname(filename).toLowerCase();
  for (const [lang, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (extensions.includes(ext)) return lang;
  }
  return "unknown";
}

function isCodeFile(filename) {
  const ext = path.extname(filename).toLowerCase();

  // Skip CSS and related files
  if (IGNORE_EXTENSIONS.includes(ext)) {
    return false;
  }

  return Object.values(LANGUAGE_EXTENSIONS).flat().includes(ext);
}

function isDependencyFile(filename) {
  return DEPENDENCY_FILES.includes(path.basename(filename));
}

function shouldIgnoreFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return IGNORE_EXTENSIONS.includes(ext);
}

function readCodeFiles(dirPath) {
  const files = [];
  const ignoreDirs = [".git", "node_modules", "vendor", "dist", "build", "pycache", "__pycache__"];
  const ignoreFiles = [".DS_Store", "Thumbs.db"];

  function readRecursive(currentPath) {
    const items = fs.readdirSync(currentPath);
    for (const item of items) {
      if (ignoreDirs.includes(item)) continue;

      const fullPath = path.join(currentPath, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        readRecursive(fullPath);
      } else if (stat.isFile() && !ignoreFiles.includes(item)) {
        // Skip CSS and related files
        if (shouldIgnoreFile(fullPath)) {
          continue;
        }

        if (isCodeFile(fullPath) || isDependencyFile(fullPath)) {
          try {
            const content = fs.readFileSync(fullPath, "utf8");
            files.push({
              path: fullPath,
              content,
              language: isDependencyFile(fullPath)
                ? "dependency"
                : detectLanguage(fullPath),
            });
          } catch {
            console.log(`Skipping file: ${fullPath}`);
          }
        }
      }
    }
  }

  readRecursive(dirPath);
  return files;
}

// ------------------- SSE -------------------
let clients = [];
app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.push(res);
  req.on("close", () => {
    clients = clients.filter((c) => c !== res);
  });
});

function broadcast(event, data) {
  clients.forEach((res) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// ------------------- GEMINI CALL (DUAL API) -------------------
async function callGeminiAPI(codeContent, language, retries = 3) {
  const prompt = `
You are an expert code analyzer for ${language}.
Check for: syntax errors, dependency issues, duplicate code, security risks, performance problems, and best practice violations.
Return ONLY valid JSON like this:

{
  "issues": [
    { "line": 10, "type": "syntax_error", "message": "Issue description", "suggestion": "Suggested fix" }
  ]
}

Types: syntax_error, dependency, duplicate, security, performance, best_practice
Code:\n${codeContent}
`;

  for (let attempt = 0; attempt < retries; attempt++) {
    const { key: apiKey, index: apiIndex } = getBestApiKey();
    
    try {
      broadcast("progress", { 
        message: `🤖 Using API ${apiIndex + 1} (Attempt ${attempt + 1}/${retries})` 
      });

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );

      if (response.status === 429) {
        // Rate limited - mark this API as problematic and try another
        markApiError(apiIndex);
        broadcast("progress", { 
          message: `⏳ Rate limited on API ${apiIndex + 1}, retrying with different API...` 
        });
        await delay(3000 * (attempt + 1));
        continue;
      }

      if (response.status === 403) {
        // Quota exceeded - mark this API as problematic
        markApiError(apiIndex);
        broadcast("progress", { 
          message: `🚫 Quota exceeded on API ${apiIndex + 1}, switching API...` 
        });
        await delay(2000);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // Handle empty response
      if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        throw new Error("Empty response from Gemini API");
      }

      let text = data.candidates[0].content.parts[0].text.trim();

      // Clean up JSON response
      if (text.startsWith("```json")) {
        text = text.slice(7);
      }
      if (text.endsWith("```")) {
        text = text.slice(0, -3);
      }
      text = text.replace(/```/g, "").trim();

      const result = JSON.parse(text);
      
      // Reset error count on successful call
      if (apiUsage[apiIndex].errors > 0) {
        apiUsage[apiIndex].errors = Math.max(0, apiUsage[apiIndex].errors - 1);
      }
      
      return result;
    } catch (err) {
      console.error(`Gemini API ${apiIndex + 1} attempt ${attempt + 1} failed:`, err.message);
      markApiError(apiIndex);
      
      if (attempt === retries - 1) {
        return {
          issues: [{ 
            line: 0, 
            type: "error", 
            message: `Analysis failed after ${retries} attempts: ${err.message}`, 
            suggestion: "Try again later or with smaller files" 
          }],
        };
      }
      
      await delay(2000 * (attempt + 1));
    }
  }
}

// ------------------- BATCH ANALYSIS -------------------
async function analyzeFilesInBatches(files, batchSize = 5) {
  const results = [];
  const total = files.length;
  let processed = 0;

  if (total === 0) {
    return results;
  }

  broadcast("progress", { 
    message: `📑 Starting batch analysis of ${total} files (Batch size: ${batchSize})`, 
    progress: 0 
  });

  // Process files in batches to avoid overwhelming the APIs
  for (let i = 0; i < total; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(total / batchSize);

    broadcast("progress", {
      message: `🔄 Processing batch ${batchNumber}/${totalBatches} (${batch.length} files)`,
      progress: (i / total) * 100
    });

    const batchPromises = batch.map(async (file, index) => {
      const fileNumber = i + index + 1;
      const progress = ((fileNumber / total) * 100).toFixed(1);

      broadcast("progress", { 
        message: `🔍 [${fileNumber}/${total}] (${progress}%) Analyzing ${path.basename(file.path)}`, 
        progress 
      });

      let issues = [];

      try {
        const aiResult = await callGeminiAPI(file.content, file.language);
        if (aiResult && aiResult.issues) {
          broadcast("progress", {
            message: `✅ Analyzed ${path.basename(file.path)}, found ${aiResult.issues.length} issues`,
            progress,
          });
          issues = aiResult.issues;
        }
      } catch (error) {
        console.error(`Error analyzing ${file.path}:`, error);
        issues = [{ 
          line: 0, 
          type: "error", 
          message: "Analysis failed", 
          suggestion: "Try again" 
        }];
      }

      processed++;
      return { 
        file: file.path, 
        language: file.language, 
        issues 
      };
    });

    // Wait for current batch to complete
    const batchResults = await Promise.allSettled(batchPromises);
    
    // Process batch results
    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        const file = batch[index];
        results.push({
          file: file.path,
          language: file.language,
          issues: [{ 
            line: 0, 
            type: "error", 
            message: "Batch analysis failed", 
            suggestion: "Try again" 
          }]
        });
      }
    });

    // Delay between batches to avoid rate limiting
    if (i + batchSize < total) {
      broadcast("progress", {
        message: `⏳ Waiting before next batch...`,
        progress: ((i + batchSize) / total) * 100
      });
      await delay(3000);
    }
  }

  broadcast("progress", { 
    message: `🎉 Analysis complete! Processed ${processed}/${total} files successfully`, 
    progress: 100 
  });
  broadcast("end", { message: "🚀 Analysis complete." });
  
  return results;
}

// ------------------- ROUTES -------------------

// Direct code analysis
app.post("/api/analyze/code", async (req, res) => {
  try {
    const { code, filename = "code.txt" } = req.body;
    if (!code) return res.status(400).json({ error: "No code provided" });

    const language = detectLanguage(filename);
    const aiResponse = await callGeminiAPI(code, language !== "unknown" ? language : "javascript");
    res.json(aiResponse);
  } catch (error) {
    console.error("Code analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Upload only
app.post("/api/upload", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const uploadId = Date.now().toString();
    const extractPath = path.join(EXTRACTED_PATH, uploadId);
    fs.mkdirSync(extractPath, { recursive: true });

    for (const file of req.files) {
      const dest = path.join(extractPath, file.originalname);
      fs.renameSync(file.path, dest);
    }

    res.json({ success: true, uploadId, fileCount: req.files.length });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Analyze uploaded folder with batch processing
app.post("/api/analyze/:uploadId", async (req, res) => {
  try {
    const { uploadId } = req.params;
    const { batchSize = 5 } = req.body; // Allow client to specify batch size
    const extractPath = path.join(EXTRACTED_PATH, uploadId);

    if (!fs.existsSync(extractPath)) {
      return res.status(400).json({ error: "Upload not found" });
    }

    const files = readCodeFiles(extractPath);
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });

    broadcast("progress", {
      message: `📊 Found ${files.length} code files. Starting batch analysis...`
    });

    const aiResponse = await analyzeFilesInBatches(files, parseInt(batchSize));
    res.json(aiResponse);
  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({ error: "Analysis failed" });
  }
});

// Upload & analyze directly with batch processing
app.post("/api/analyze/upload", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const extractPath = path.join(EXTRACTED_PATH, Date.now().toString());
    fs.mkdirSync(extractPath, { recursive: true });

    for (const file of req.files) {
      const dest = path.join(extractPath, file.originalname);
      fs.renameSync(file.path, dest);
    }

    const files = readCodeFiles(extractPath);
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });

    broadcast("progress", {
      message: `📊 Found ${files.length} code files. Starting batch analysis...`
    });

    const aiResponse = await analyzeFilesInBatches(files, 5); // Default batch size 5
    res.json(aiResponse);
  } catch (error) {
    console.error("Upload analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ... (rest of your routes remain the same - GitHub analysis, health check, etc.)

// Download & extract GitHub repo ZIP
async function downloadRepoZip(repoUrl, extractPath, token = null) {
  try {
    const match = repoUrl.match(/github.com\/([^\/]+)\/([^\/]+)(?:\.git)?/);
    if (!match) throw new Error("Invalid GitHub URL");

    const owner = match[1];
    const repo = match[2];

    const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/main`;    

    const headers = {    
      "User-Agent": "Vektor-Insight",    
      Accept: "application/vnd.github.v3+json",    
    };    
    if (token) headers["Authorization"] = `token ${token}`;    

    const response = await fetch(zipUrl, { headers });    
    if (!response.ok) {    
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);    
    }    

    const buffer = Buffer.from(await response.arrayBuffer());    
    const zipPath = path.join(extractPath, "repo.zip");    
    fs.writeFileSync(zipPath, buffer);    

    const zip = new AdmZip(zipPath);    
    zip.extractAllTo(extractPath, true);    

    return true;
  } catch (err) {
    console.error("Error downloading repo ZIP:", err.message);
    return false;
  }
}

// GitHub repo analysis with batch processing
app.post("/analyze/github", async (req, res) => {
  try {
    const { repoUrl, token, batchSize = 5 } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "Repository URL is required" });

    const repoPath = path.join(REPOS_PATH, Date.now().toString());    
    fs.mkdirSync(repoPath, { recursive: true });    

    if (!(await downloadRepoZip(repoUrl, repoPath, token))) {    
      return res.status(500).json({ error: "Failed to download repo" });    
    }    

    // GitHub ZIPs extract into a single subfolder    
    const subDirs = fs.readdirSync(repoPath).filter(item => 
      !item.endsWith('.zip') && fs.statSync(path.join(repoPath, item)).isDirectory()
    );

    if (subDirs.length === 0) {
      return res.status(500).json({ error: "No extracted content found" });
    }

    const extractedRoot = path.join(repoPath, subDirs[0]);    
    const files = readCodeFiles(extractedRoot);    
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });    

    broadcast("progress", {
      message: `📊 Found ${files.length} code files in repository. Starting batch analysis...`
    });

    const aiResponse = await analyzeFilesInBatches(files, parseInt(batchSize));    
    res.json(aiResponse);
  } catch (error) {
    console.error("GitHub analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Health check with API status
app.get("/health", (req, res) => {
  resetApiUsage();
  res.json({ 
    status: "OK", 
    message: "Server running",
    apiStatus: apiUsage.map((usage, index) => ({
      api: index + 1,
      requests: usage.requests,
      errors: usage.errors,
      lastReset: new Date(usage.lastReset).toISOString()
    }))
  });
});

// API status endpoint
app.get("/api/status", (req, res) => {
  resetApiUsage();
  res.json({
    totalApis: GEMINI_API_KEYS.length,
    usage: apiUsage.map((usage, index) => ({
      api: index + 1,
      requests: usage.requests,
      errors: usage.errors,
      health: usage.errors > 10 ? "poor" : usage.errors > 5 ? "degraded" : "good"
    }))
  });
});

// Start server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));