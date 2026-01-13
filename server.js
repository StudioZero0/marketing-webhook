// server.js - Studio Zero Production Edition
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const os = require("os");
const util = require("util");

const execFileAsync = util.promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json());

// Helper: download a file from url to local path
async function downloadToFile(url, destPath) {
  console.log("Downloading file from", url, "to", destPath);
  const writer = fs.createWriteStream(destPath);

  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
    headers: { 
        // מתחזה לדפדפן רגיל כדי שגוגל דרייב לא יחסום
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" 
    }
  });

  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    let error = null;
    writer.on("error", (err) => {
      error = err;
      writer.close();
      console.error("Error writing downloaded file:", err);
      reject(err);
    });
    writer.on("close", () => {
      if (!error) {
        console.log("Finished downloading to", destPath);
        resolve();
      }
    });
  });
}

// Helper: get audio duration using ffprobe
async function getAudioDurationSeconds(audioPath) {
  try {
    console.log("Running ffprobe on:", audioPath);
    const { stdout, stderr } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    const sec = Math.max(1, Number((stdout || "").trim() || "0"));
    console.log("Audio duration (seconds):", sec);
    return sec;
  } catch (err) {
    console.error("ffprobe error:", err);
    throw new Error("ffprobe failed: " + (err.stderr || err.message));
  }
}

app.post("/render", async (req, res) => {
  // הגדלת זמן ה-Timeout של השרת עצמו כדי שלא ינתק את הקשר בוידאו ארוך
  req.setTimeout(300000); // 5 דקות

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  const screenshotPath = path.join(tmpDir, "screenshot.png");
  const audioPath = path.join(tmpDir, "audio.mp3");
  const outPath = path.join(tmpDir, "out.mp4");

  console.log("----- /render called -----");
  console.log("Temp dir:", tmpDir);

  try {
    const { website_url, audio_url } = req.body || {};
    console.log("Incoming /render", { website_url, audio_url });

    if (!website_url || !audio_url) {
      return res.status(400).json({ error: "website_url and audio_url are required" });
    }

    // 1) Download audio
    await downloadToFile(audio_url, audioPath);

    // 2) Capture screenshot - Studio Quality
    const normalizedUrl = /^https?:\/\//i.test(website_url) ? website_url : `https://${website_url}`;

    console.log("Launching Playwright Chromium...");
    const browser = await chromium.launch();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 }, // Full HD
      deviceScaleFactor: 2 // RETINA QUALITY: This makes the text sharp!
    });
    const page = await context.newPage();

    page.setDefaultNavigationTimeout(60000); // 60s
    try {
      console.log("Going to website:", normalizedUrl);
      // מחכים עד שהרשת נרגעת (networkidle) כדי לוודא שכל התמונות נטענו
      await page.goto(normalizedUrl, { waitUntil: "networkidle", timeout: 45000 });
    } catch (e) {
      console.warn("goto timeout, capturing what we have...");
    }
    
    // Smooth scrolling simulation for better rendering (optional, but good for lazy loading images)
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if(totalHeight >= 1000){ // Scroll just a bit to trigger animations
                    clearInterval(timer);
                    window.scrollTo(0, 0); // Go back top
                    resolve();
                }
            }, 50);
        });
    });
    await page.waitForTimeout(1000); // Settle

    await page.screenshot({ path: screenshotPath, fullPage: false });
    await browser.close();
    console.log("Screenshot saved.");

    // 3) Get audio duration
    const durationSec = await getAudioDurationSeconds(audioPath);

    // 4) Build video with ffmpeg - High Quality Settings
    const ffmpegArgs = [
      "-loop", "1",
      "-y",
      "-i", screenshotPath,
      "-i", audioPath,
      "-c:v", "libx264",
      "-t", String(durationSec),
      "-pix_fmt", "yuv420p", // Critical for compatibility with QuickTime/Mac
      "-preset", "medium",   // Balance between speed and quality
      "-c:a", "aac",
      "-b:a", "192k",        // High quality audio
      "-shortest",
      "-movflags", "+faststart",
      "-r", "30",
      outPath,
    ];

    console.log("Running ffmpeg...");
    await execFileAsync("ffmpeg", ffmpegArgs);

    console.log("Reading output file:", outPath);
    const mp4 = fs.readFileSync(outPath);
    res.setHeader("Content-Type", "video/mp4");
    res.send(mp4);
    console.log("Video sent to client");

  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).json({ error: "internal error", details: err.message });
  } finally {
    // cleanup
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (e) { console.error("Cleanup error:", e); }
  }
});

const PORT = process.env.PORT || 8080;
// Critical change: listen on 0.0.0.0 for Docker/Railway
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Studio Zero Render Server listening on port ${PORT}`);
});
