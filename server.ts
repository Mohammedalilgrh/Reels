import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import axios from 'axios';
import { exec } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import arabicReshaper from 'arabic-reshaper';
import bidiFactory from 'bidi-js';
import { v4 as uuidv4 } from 'uuid';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

console.log('bidiFactory type:', typeof bidiFactory);
let bidi: any;
try {
  const bf: any = (bidiFactory as any).default || bidiFactory;
  if (typeof bf === 'function') {
    try {
      bidi = bf();
    } catch (e) {
      console.warn('Bidi factory call failed, using as object:', e);
      bidi = bf;
    }
  } else {
    bidi = bf;
  }
} catch (e) {
  console.error('Bidi initialization failed:', e);
}
console.log('bidi instance methods:', Object.keys(bidi || {}));

// Helper to shape Arabic text for FFmpeg
const shapeArabic = (text: string) => {
  try {
    console.log('Shaping Text:', text);
    // Handle different export styles of arabic-reshaper (ESM/CommonJS interop)
    const reshaper: any = (arabicReshaper as any).default || arabicReshaper;
    const reshaped = typeof reshaper.reshape === 'function' 
      ? reshaper.reshape(text) 
      : typeof reshaper === 'function' 
        ? reshaper(text) 
        : text;
    let bidiText = reshaped;
    if (bidi) {
      if (typeof bidi.getReorderedText === 'function') {
        bidiText = bidi.getReorderedText(reshaped);
      } else if (typeof bidi === 'function') {
        bidiText = bidi(reshaped);
      }
    }
    console.log('Reshaped Text:', bidiText);
    return bidiText;
  } catch (e) {
    console.error('Shaping Error:', e);
    return text;
  }
};

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(TEMP_DIR);

const upload = multer({ dest: TEMP_DIR });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));

const PEXELS_API_KEY = process.env.PEXELS_API_KEY || 'dCkyhy7qmXXJTlwihS24WAZK2Fe5CbeKti2VF0Och26k7pi3bcocnQK9';
const VOICERSS_API_KEY = process.env.VOICE_API_KEY || '044f12cbbc0946fb98eeaeace7580a60';

function escapeFFmpegText(text: string) {
  // FFmpeg drawtext escaping: \ is \\, ' is '\'' (in single quotes), : is \:
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "'\\''")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,");
}

// API Endpoints
app.post('/api/generate-video', async (req, res) => {
  const { topic, scenes: providedScenes, audioBase64, audioMimeType, style } = req.body;

  if (!providedScenes || !Array.isArray(providedScenes) || !audioBase64) {
    return res.status(400).json({ error: 'Valid scenes and audio are required' });
  }

  const requestId = uuidv4();
  // Use appropriate extension based on mimeType
  const isPcm = audioMimeType?.includes('pcm');
  const audioExt = isPcm ? '.raw' : (audioMimeType?.split('/')[1] || 'mp3');
  const audioPath = path.join(TEMP_DIR, `${requestId}_audio${audioExt}`);
  const outputPath = path.join(UPLOADS_DIR, `${requestId}_final.mp4`);

  try {
    console.log(`Starting generation for topic: ${topic} (Mime: ${audioMimeType})`);
    
    // 1. Save Audio
    console.log('Saving audio...');
    await fs.writeFile(audioPath, Buffer.from(audioBase64, 'base64'));

    // 2. Get Audio Duration
    const getDuration = (file: string): Promise<number> => {
      return new Promise((resolve, reject) => {
        const probeCommand = isPcm 
          ? `ffprobe -v error -f s16le -ar 24000 -ac 1 -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`
          : `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`;
        
        exec(probeCommand, (err: any, stdout: string) => {
          if (err) {
            console.error('Probe Error:', err);
            resolve(0); // Fallback
          } else {
            resolve(parseFloat(stdout) || 0);
          }
        });
      });
    };

    const totalDurationRaw = await getDuration(audioPath);
    console.log(`Raw audio duration: ${totalDurationRaw}s (Mime: ${audioMimeType})`);
    
    // Ensure we have a valid positive number for duration
    const totalDuration = (typeof totalDurationRaw === 'number' && !isNaN(totalDurationRaw) && totalDurationRaw > 0) 
      ? totalDurationRaw 
      : 5; 
    
    if (totalDuration === 5) {
      console.warn('Warning: Using fallback duration of 5s. Audio probe might have failed.');
    }
    
    console.log(`Using total duration: ${totalDuration}s`);

    // 3. Calculate scene durations based on text length ratio
    const totalChars = providedScenes.reduce((acc: number, s: any) => acc + (s.text?.length || 0), 0) || 1;
    const initialScenes = providedScenes.map((s: any) => {
      const charCount = s.text?.length || 0;
      const calculatedDuration = (charCount / totalChars) * totalDuration;
      return {
        ...s,
        duration: Math.max(0.5, calculatedDuration) // At least 0.5s per scene
      };
    });

    // 4. Fetch and Download Images for each scene using provided keywords
    const sceneImagePaths: string[] = [];
    const validScenes: any[] = [];

    for (let i = 0; i < initialScenes.length; i++) {
      const scene = initialScenes[i];
      console.log(`Fetching image for scene ${i + 1} with keyword: ${scene.keyword}`);
      
      try {
        const pexelsRes = await axios.get('https://api.pexels.com/v1/search', {
          params: { query: scene.keyword || topic || 'cinematic', orientation: 'portrait', per_page: 1 },
          headers: { Authorization: PEXELS_API_KEY }
        });

        const imageData = pexelsRes.data.photos[0];
        if (imageData) {
          const imageUrl = imageData.src.large2x || imageData.src.large;
          const scenePath = path.join(TEMP_DIR, `${requestId}_scene_${i}.jpg`);
          
          const imageStream = await axios.get(imageUrl, { responseType: 'stream' });
          const writer = fs.createWriteStream(scenePath);
          
          await new Promise((resolve, reject) => {
            imageStream.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
            imageStream.data.on('error', reject);
          });
          
          sceneImagePaths.push(scenePath);
          validScenes.push(scene);
        }
      } catch (e) {
        console.error(`Failed to fetch image for scene ${i}`, e);
      }
    }

    if (sceneImagePaths.length === 0) throw new Error('Could not find any visuals for your script.');

    // 5. Process with FFmpeg (Professional Cinematic Format using Images)
    console.log('Processing with FFmpeg (Cinematic 9:16 from Images)...');
    
    const filterComplex = [];
    for (let i = 0; i < sceneImagePaths.length; i++) {
      const scene = validScenes[i];
      // Professional text wrapping and cleaning
      const cleanText = scene.text.replace(/'/g, "");
      const shapedText = shapeArabic(cleanText);
      const wrappedText = shapedText.match(/.{1,20}(\s|$)/g)?.join('\n') || shapedText;
      
      // Cinematic Filter: 4:3 content centered in 9:16 frame with black bars
      // Subtitle style: Bold yellow text with black border, positioned in the black bar area or lower 4:3 area
      const escapedText = escapeFFmpegText(wrappedText);
      const fontPath = path.join(__dirname, 'Amiri-Bold.ttf');
      
      filterComplex.push(
        `[${i}:v]scale=1080:810:force_original_aspect_ratio=increase,crop=1080:810,` + // Scale to 4:3 (1080x810)
        `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,` + // Pad to 9:16 (1080x1920) with black bars
        `setsar=1,format=yuv420p,` +
        `eq=brightness=0.02:contrast=1.2:saturation=1.3,` + 
        `drawtext=fontfile='${fontPath}':text='${escapedText}':fontcolor=yellow:fontsize=75:borderw=4:bordercolor=black:line_spacing=20:x=(w-text_w)/2:y=(h+810)/2+20:fix_bounds=true[v${i}]`
      );
    }

    const finalFilters = [
      ...filterComplex,
      // Concat segments
      `${sceneImagePaths.map((_, i) => `[v${i}]`).join('')}concat=n=${sceneImagePaths.length}:v=1:a=0[outv]`,
      // Mix voiceover and background music
      `[${sceneImagePaths.length}:a]volume=1.5[vo]`,
      `[${sceneImagePaths.length + 1}:a]volume=0.1[bg]`,
      `[vo][bg]amix=inputs=2:duration=first[outa]`
    ];

    console.log('Final Filter Complex:', finalFilters);

    await new Promise((resolve, reject) => {
      let command = ffmpeg();
      sceneImagePaths.forEach((p, idx) => {
        // Use the duration from the corresponding valid scene
        command = command.input(p).inputOptions(['-loop 1', `-t ${validScenes[idx].duration}`]);
      });
      
      // Add the audio input
      if (isPcm) {
        command = command.input(audioPath).inputOptions([
          '-f s16le',
          '-ar 24000',
          '-ac 1'
        ]);
      } else {
        command = command.input(audioPath);
      }

      // Add background music
      const bgMusicPath = path.join(__dirname, 'SoundHelix-Song-1.mp3');
      command = command.input(bgMusicPath).inputOptions(['-stream_loop -1']);

      command
        .complexFilter(finalFilters)
        .outputOptions([
          '-map [outv]',
          '-map [outa]',
          '-c:v libx264',
          '-preset fast',
          '-crf 22',
          '-c:a aac',
          '-b:a 192k',
          '-shortest',
          '-pix_fmt yuv420p'
        ])
        .on('start', (cmd) => console.log('FFmpeg Command:', cmd))
        .on('end', resolve)
        .on('error', (err) => {
          console.error('FFmpeg Error:', err.message);
          reject(err);
        })
        .save(outputPath);
    });

    console.log('Generation complete!');
    res.json({
      success: true,
      downloadUrl: `/uploads/${requestId}_final.mp4`,
      filename: `${requestId}_final.mp4`
    });

  } catch (error: any) {
    console.error('Error generating video:', error.message);
    res.status(500).json({ error: error.message || 'Failed to generate video' });
  } finally {
    // Cleanup temp files
    try {
      if (await fs.pathExists(audioPath)) await fs.remove(audioPath);
      // Clean up all scene videos
      const files = await fs.readdir(TEMP_DIR);
      for (const file of files) {
        if (file.startsWith(requestId)) {
          await fs.remove(path.join(TEMP_DIR, file));
        }
      }
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
  }
});

app.get('/download/:filename', (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Vite middleware for development
async function startServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });

  if (process.env.NODE_ENV !== 'production') {
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      console.log('Vite middleware loaded');
    } catch (err) {
      console.error('Failed to start Vite:', err);
    }
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    if (await fs.pathExists(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }
}

startServer();
