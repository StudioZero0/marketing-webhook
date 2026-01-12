import express from "express";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import fetch from "node-fetch";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json({ limit: "10mb" }));

const TMP = "./tmp";
const ASSETS = "./assets"; // שים כאן logo.png
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });

async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

async function getAudioDurationSeconds(audioPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    audioPath,
  ]);
  return Math.max(1, Number(stdout.trim()));
}

app.post("/render", async (req, res) => {
  try {
    const { website_url, audio_url } = req.body;
    if (!website_url || !audio_url) {
      return res
        .status(400)
        .json({ error: "website_url and audio_url are required" });
    }

    const ts = Date.now();
    const screenshotPath = path.join(TMP, `hero-${ts}.png`);
    const audioPath = path.join(TMP, `audio-${ts}.mp3`);
    const outPath = path.join(TMP, `out-${ts}.mp4`);

    // לוגו (שים קובץ: ./assets/logo.png)
    const logoPath = path.join(ASSETS, "logo.png");
    const hasLogo = fs.existsSync(logoPath);

    // 1) download audio
    await downloadToFile(audio_url, audioPath);

    // 2) HERO screenshot (לא fullPage) - רק המסך הראשון
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 720, height: 1280 } });

    // domcontentloaded יותר יציב מאשר networkidle
    await page.goto(website_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    await browser.close();

    // 3) Build video: Intro (1.5s) + Hero static + End card (4s)
    const audioT = await getAudioDurationSeconds(audioPath);

    const intro = 1.5; // שניות פתיח
    const endCard = 4.0; // שניות בסוף ל-CTA
    const total = Math.max(5, intro + audioT + endCard); // אורך סופי של הוידאו
    const endStart = Math.max(0, total - endCard);

    // אם אין logo.png - עדיין ייצא וידאו בלי לוגו
    const ffmpegArgs = [
      "-y",
      "-loop",
      "1",
      "-i",
      screenshotPath,
      "-i",
      audioPath,
    ];

    if (hasLogo) {
      ffmpegArgs.push("-i", logoPath);
    }

    // טקסטים (אפשר לשנות חופשי)
    const brandLine1 = "STUDIO ZERO";
    const brandLine2 = "Automated mini-audit - 30 seconds";
    const ctaLine1 = "Want the Blueprint?";
    const ctaLine2 = "Reply: BLUEPRINT";

    // הערה: drawtext על mac לפעמים דורש fontfile. אם הטקסט לא מופיע - תגיד לי ואביא לך גרסת fontfile.
    // כאן אנחנו מנסים בלי fontfile קודם (הכי פשוט).

    const filterParts = [];

    // בסיס: תמונה בגודל 720x1280
    filterParts.push(
      `[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,format=rgba[base]`
    );

    if (hasLogo) {
      // לוגו + shadow (פינה שמאל למעלה)
      filterParts.push(`[2:v]format=rgba,scale=140:-1[logo]`);
      filterParts.push(
        `[logo]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.35,boxblur=10:1[shadow]`
      );
      filterParts.push(`[base][shadow]overlay=24:24[b1]`);
      filterParts.push(`[b1][logo]overlay=20:20[b2]`);
    } else {
      filterParts.push(`[base]copy[b2]`);
    }

    // פתיח - טקסטים רק בזמן intro
    filterParts.push(
      `[b2]drawtext=text='${brandLine1}':x=40:y=40:fontsize=44:fontcolor=white:enable='lt(t,${intro})'[b3]`
    );
    filterParts.push(
      `[b3]drawtext=text='${brandLine2}':x=40:y=95:fontsize=28:fontcolor=white:enable='lt(t,${intro})'[b4]`
    );

    // End card: שכבה כהה + CTA בשניות האחרונות
    filterParts.push(
      `[b4]drawbox=x=0:y=0:w=720:h=1280:color=black@0.55:t=fill:enable='gte(t,${endStart})'[b5]`
    );
    filterParts.push(
      `[b5]drawtext=text='${ctaLine1}':x=40:y=540:fontsize=46:fontcolor=white:enable='gte(t,${endStart})'[b6]`
    );
    filterParts.push(
      `[b6]drawtext=text='${ctaLine2}':x=40:y=610:fontsize=34:fontcolor=white:enable='gte(t,${endStart})'[v]`
    );

    const filterComplex = filterParts.join("; ");

    ffmpegArgs.push(
      "-t",
      String(total), // קובע אורך לוידאו
      "-filter_complex",
      filterComplex,
      "-map",
      "[v]",
      "-map",
      "1:a",
      // דיליי לאודיו כדי שיתחיל אחרי intro
      "-af",
      `adelay=${Math.round(intro * 1000)}|${Math.round(intro * 1000)},apad`,
      "-shortest",
      "-movflags",
      "+faststart",
      "-r",
      "30",
      "-pix_fmt",
      "yuv420p",
      outPath
    );

    await execFileAsync("ffmpeg", ffmpegArgs);

    const mp4 = fs.readFileSync(outPath);
    res.setHeader("Content-Type", "video/mp4");
    res.send(mp4);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(8080, () =>
  console.log("Worker listening on http://localhost:8080")
);
