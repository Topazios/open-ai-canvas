import { DramaVoiceLanguage } from "./short-drama-settings-catalog";
import type { ShortDramaGlobalSettings } from "./short-drama-settings";

export enum ProductionSoundKind {
    Voice = "voice", Prop = "prop", Ambience = "ambience", Music = "music",
}
export const productionSoundKindOptions = [
    { value: ProductionSoundKind.Voice, label: "人物声线" }, { value: ProductionSoundKind.Prop, label: "道具动作声" },
    { value: ProductionSoundKind.Ambience, label: "环境声" }, { value: ProductionSoundKind.Music, label: "音乐母题" },
];

// All characters share the same calibration text in a production language.
// Unsupported languages require a supplied text instead of a Mandarin fallback.
export const voiceCalibrationTexts: Readonly<Record<DramaVoiceLanguage, string>> = {
    [DramaVoiceLanguage.Mandarin]: "早上好。窗外的风停了，桌上还有一杯温水。我会把事情说清楚，请你听完，再告诉我你的决定。",
    [DramaVoiceLanguage.Cantonese]: "早晨。窗外嘅风停咗，台面仲有一杯暖水。我会讲清楚件事，你听完之后再话我知你嘅决定。",
    [DramaVoiceLanguage.English]: "Good morning. The wind outside has stopped, and there is a glass of water on the table. Let me explain what happened, then tell me what you decide.",
    [DramaVoiceLanguage.Japanese]: "おはようございます。窓の外の風は止み、テーブルにはまだ水が一杯あります。事情を説明しますので、最後まで聞いてから決めてください。",
    [DramaVoiceLanguage.Korean]: "좋은 아침이에요. 창밖의 바람은 멎었고, 탁자 위에는 물 한 잔이 남아 있어요. 무슨 일이 있었는지 설명할 테니 끝까지 듣고 결정해 주세요.",
    [DramaVoiceLanguage.Spanish]: "Buenos días. El viento de afuera se ha detenido y queda un vaso de agua sobre la mesa. Te explicaré lo ocurrido; escúchame hasta el final y dime qué decides.",
    [DramaVoiceLanguage.French]: "Bonjour. Le vent dehors s'est arrêté et il reste un verre d'eau sur la table. Je vais expliquer ce qui s'est passé; écoutez jusqu'au bout, puis dites-moi votre décision.",
    [DramaVoiceLanguage.Portuguese]: "Bom dia. O vento lá fora parou e ainda há um copo de água sobre a mesa. Vou explicar o que aconteceu; ouça até o fim e diga o que decide.",
    [DramaVoiceLanguage.Thai]: "สวัสดีตอนเช้า ลมข้างนอกหยุดแล้ว และบนโต๊ะยังมีน้ำหนึ่งแก้ว ฉันจะอธิบายว่าเกิดอะไรขึ้น ฟังให้จบแล้วบอกการตัดสินใจของคุณ",
    [DramaVoiceLanguage.Indonesian]: "Selamat pagi. Angin di luar sudah berhenti dan masih ada segelas air di meja. Aku akan menjelaskan apa yang terjadi; dengarkan sampai selesai lalu beri tahu keputusanmu.",
    [DramaVoiceLanguage.Vietnamese]: "Chào buổi sáng. Gió bên ngoài đã ngừng và trên bàn vẫn còn một ly nước. Tôi sẽ nói rõ chuyện đã xảy ra; hãy nghe hết rồi cho tôi biết quyết định của bạn.",
    [DramaVoiceLanguage.Filipino]: "Magandang umaga. Tumigil na ang hangin sa labas at may isang basong tubig sa mesa. Ipaliwanag ko ang nangyari; makinig hanggang dulo at sabihin ang iyong desisyon.",
    [DramaVoiceLanguage.Hindi]: "सुप्रभात। बाहर हवा रुक गई है और मेज़ पर अभी भी एक गिलास पानी है। मैं बताऊँगा कि क्या हुआ, अंत तक सुनिए और फिर अपना निर्णय बताइए।",
    [DramaVoiceLanguage.Arabic]: "صباح الخير. توقفت الرياح في الخارج وما زال على الطاولة كوب من الماء. سأشرح ما حدث، فاستمع حتى النهاية ثم أخبرني بقرارك.",
    [DramaVoiceLanguage.German]: "Guten Morgen. Der Wind draußen hat aufgehört, und auf dem Tisch steht noch ein Glas Wasser. Ich erkläre, was passiert ist; hör bis zum Ende zu und sag mir dann deine Entscheidung.",
};

export function projectVoiceCalibration(settings?: ShortDramaGlobalSettings) {
    if (!settings) return "";
    return settings.voiceCalibrationLanguage === settings.voiceLanguage && settings.voiceCalibrationText?.trim()
        ? settings.voiceCalibrationText.trim() : voiceCalibrationTexts[settings.voiceLanguage] || "";
}

export function soundDesignMaterial(content: string) {
    const fields = new Set(["声音核心设计与听觉辨识特征", "音色、频段、质感与声源构成", "节奏、速度、时长与循环规则", "情绪功能、强度与动态范围", "距离、方位、混响与空间层次", "触发、进入、退出与同步时点", "声音生成提示词与声线复用要求", "声音跨集复用与变化规则"]);
    const sections = content.split(/(?=^## )/m);
    return sections.filter(section => fields.has(/^## (.+)$/m.exec(section)?.[1]?.trim() || "")).join("\n").trim() || content.trim();
}
