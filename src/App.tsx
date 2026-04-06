import { useState, useRef } from 'react';
import { 
  Video, 
  Type, 
  Mic, 
  Palette, 
  Play, 
  Download, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  Info
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Modality } from "@google/genai";

export default function App() {
  const [topic, setTopic] = useState('');
  const [script, setScript] = useState('');
  const [voice, setVoice] = useState('female');
  const [style, setStyle] = useState('travel');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleGenerate = async () => {
    if (!topic || !script) {
      setError('يرجى إدخال الموضوع والنص المطلوب');
      return;
    }

    setLoading(true);
    setError(null);
    setVideoUrl(null);
    setProgress('جاري تحليل النص وتوليد الصوت الذكي...');

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      // 1. Generate optimized keywords for each scene using Gemini
      const keywordResponse = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `حلل النص التالي وقسمه إلى مشاهد قصيرة (حوالي 5-8 ثوانٍ لكل مشهد). لكل مشهد، أعطني الكلمات المفتاحية (باللغة الإنجليزية) للبحث عن صورة في Pexels تعبر عن "النتيجة النهائية" (Outcome) وليس المنتج فقط، بأسلوب سينمائي فاخر.
        النص: ${script}
        
        أريد الرد بصيغة JSON فقط كقائمة من الكائنات:
        [{ "text": "نص المشهد بالعربي", "keyword": "cinematic luxury lifestyle keyword in english" }]`,
        config: {
          responseMimeType: "application/json",
        }
      });

      const scenesData = JSON.parse(keywordResponse.text || "[]");
      if (!scenesData.length) throw new Error("فشل في تحليل مشاهد النص.");

      setProgress('جاري توليد التعليق الصوتي الطبيعي...');

      // 2. Generate high-quality TTS using Gemini
      const ttsResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `اقرأ النص التالي بأسلوب ${voice === 'female' ? 'أنثوي هادئ واحترافي' : 'ذكوري قوي وواثق'}: ${script}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice === 'female' ? 'Kore' : 'Zephyr' },
            },
          },
        },
      });

      const audioPart = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      const audioBase64 = audioPart?.data;
      const audioMimeType = audioPart?.mimeType;
      
      if (!audioBase64) throw new Error("فشل في توليد التعليق الصوتي.");

      setProgress('جاري تجميع الفيديو السينمائي...');

      // 3. Send everything to backend
      const response = await fetch('/api/generate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          topic, 
          scenes: scenesData, 
          audioBase64,
          audioMimeType,
          style 
        }),
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error('Failed to parse JSON response:', text);
        
        // Check if it's the AI Studio warmup page
        if (text.includes('Please wait while your application starts')) {
          throw new Error('الخادم قيد التشغيل حالياً، يرجى المحاولة مرة أخرى خلال ثوانٍ قليلة...');
        }

        // If it's not JSON, it might be a plain text error like "Rate exceeded."
        if (!response.ok) {
          throw new Error(text || `فشل في إنشاء الفيديو (كود: ${response.status})`);
        }
        throw new Error(`رد غير صالح من الخادم: ${text.slice(0, 100)}...`);
      }

      if (!response.ok) {
        throw new Error(data.error || 'فشل في إنشاء الفيديو');
      }

      setVideoUrl(data.downloadUrl);
      setProgress('تم إنشاء الفيديو بنجاح!');
    } catch (err: any) {
      console.error('Generation Error:', err);
      setError(err.message);
      setProgress('');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (videoUrl) {
      const link = document.createElement('a');
      link.href = videoUrl;
      link.download = 'generated_video.mp4';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  return (
    <div 
      dir="rtl"
      className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans p-4 md:p-8"
    >
      <div className="max-w-5xl mx-auto space-y-12">
        {/* Header */}
        <header className="text-center space-y-2">
          <motion.h1 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-3xl md:text-5xl font-bold tracking-tight text-white"
          >
            AI Video Creator
          </motion.h1>
          <p className="text-zinc-500 text-sm md:text-base">
            بساطة في التصميم، قوة في الإنتاج.
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Input Panel */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="lg:col-span-5 bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-sm space-y-6"
          >
            <div className="space-y-5">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">الموضوع</label>
                <input 
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="مثال: علم النفس التسويقي"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm focus:border-zinc-600 outline-none transition-colors"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">النص (السكربت)</label>
                <textarea 
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  placeholder="اكتب النص هنا..."
                  rows={5}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm focus:border-zinc-600 outline-none transition-colors resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">الصوت</label>
                  <select 
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm focus:border-zinc-600 outline-none transition-colors appearance-none cursor-pointer"
                  >
                    <option value="female">أنثوي</option>
                    <option value="male">ذكوري</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">النمط</label>
                  <select 
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm focus:border-zinc-600 outline-none transition-colors appearance-none cursor-pointer"
                  >
                    <option value="travel">سفر</option>
                    <option value="business">أعمال</option>
                    <option value="nature">طبيعة</option>
                    <option value="lifestyle">نمط حياة</option>
                  </select>
                </div>
              </div>

              <button 
                onClick={handleGenerate}
                disabled={loading}
                className="w-full bg-white text-black hover:bg-zinc-200 disabled:bg-zinc-800 disabled:text-zinc-500 font-bold py-3 rounded-lg transition-all flex items-center justify-center gap-2 mt-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    جاري المعالجة
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-current" />
                    إنشاء الفيديو
                  </>
                )}
              </button>

              <AnimatePresence>
                {progress && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-[11px] text-zinc-500 text-center"
                  >
                    {progress}
                  </motion.div>
                )}
                {error && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="p-3 bg-red-950/30 border border-red-900/50 rounded-lg text-xs text-red-400 flex items-center gap-2"
                  >
                    <AlertCircle className="w-3.5 h-3.5" />
                    {error}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>

          {/* Preview Panel */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="lg:col-span-7 space-y-4"
          >
            <div className="aspect-[9/16] bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden relative group shadow-2xl max-h-[70vh] mx-auto">
              {videoUrl ? (
                <video 
                  ref={videoRef}
                  src={videoUrl}
                  controls
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-700 space-y-4">
                  <Video className="w-12 h-12 opacity-20" />
                  <p className="text-xs uppercase tracking-widest opacity-40">Video Preview</p>
                </div>
              )}
            </div>

            {videoUrl && (
              <button 
                onClick={handleDownload}
                className="w-full bg-zinc-800 hover:bg-zinc-700 text-white py-3 rounded-xl flex items-center justify-center gap-2 transition-colors"
              >
                <Download className="w-4 h-4" />
                تحميل الفيديو النهائي
              </button>
            )}
          </motion.div>
        </div>

        {/* Footer */}
        <footer className="pt-12 border-t border-zinc-900 flex flex-col md:flex-row items-center justify-between gap-4 text-[10px] text-zinc-600 uppercase tracking-widest">
          <div className="flex gap-6">
            <span>Pexels HD</span>
            <span>Gemini TTS</span>
            <span>FFmpeg 4:3</span>
          </div>
          <p>© 2026 AI Studio Build</p>
        </footer>
      </div>
    </div>
  );
}
