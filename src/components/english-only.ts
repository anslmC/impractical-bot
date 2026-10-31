import { composeSystemInstruction } from './personality.js';

export const ENGLISH_ONLY_RETRY_INSTRUCTION =
  'The previous proposed reply was rejected because it was not written entirely in English. Write a fresh reply to the latest incoming message entirely in English. Preserve the conversation\'s meaning, tone, humor, and personality, but do not mirror, quote, translate, or carry over any non-English wording. Return only the English reply text.';

const LATIN_SCRIPT = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;
const WORD = /[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu;

const ENGLISH_WORDS = new Set([
  'a', 'about', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and',
  'any', 'are', 'around', 'as', 'ask', 'asked', 'at', 'back', 'bad', 'be',
  'because', 'been', 'before', 'being', 'believe', 'best', 'better', 'between',
  'bit', 'both', 'but', 'by', 'call', 'came', 'can', 'cannot', 'check', 'clear',
  'come', 'could', 'day', 'did', 'do', 'does', 'done', 'down', 'during', 'each',
  'early', 'even', 'ever', 'every', 'few', 'find', 'fine', 'first', 'for',
  'found', 'from', 'fun', 'funny', 'get', 'gets', 'getting', 'give', 'go',
  'going', 'gone', 'good', 'got', 'great', 'had', 'has', 'have', 'he', 'hear',
  'heard', 'hearing', 'hello', 'her', 'here', 'hers', 'hey', 'hi', 'him',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'keep',
  'kid', 'know', 'knows', 'last', 'late', 'later', 'laugh', 'like', 'little',
  'live', 'lol', 'look', 'looking', 'loud', 'love', 'made', 'make', 'many',
  'maybe', 'me', 'mean', 'might', 'mind', 'mine', 'more', 'most', 'much',
  'must', 'my', 'need', 'never', 'new', 'next', 'nice', 'night', 'no', 'not',
  'nothing', 'now', 'of', 'off', 'ok', 'okay', 'on', 'once', 'one', 'only',
  'or', 'other', 'our', 'out', 'over', 'own', 'people', 'person', 'play',
  'please', 'right', 'said', 'same', 'say', 'see', 'seen', 'she', 'should',
  'so', 'some', 'something', 'sorry', 'still', 'such', 'sure', 'talk', 'tell',
  'test', 'testing', 'than', 'thank', 'thanks', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'thing', 'think', 'this', 'those', 'though',
  'through', 'time', 'to', 'today', 'tomorrow', 'too', 'told', 'try', 'up',
  'us', 'very', 'want', 'was', 'way', 'we', 'well', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'why', 'will', 'with', 'without', 'work',
  'would', 'wrong', 'yeah', 'yes', 'yesterday', 'you', 'your', 'yours',
]);

const NON_ENGLISH_MARKERS = new Set([
  'ako', 'akin', 'alam', 'amin', 'ang', 'ano', 'atin', 'ay', 'ayaw', 'ba',
  'bagong', 'balita', 'bakit', 'basta', 'bago', 'bigay', 'buhay', 'bukas',
  'dahil', 'daw', 'din', 'dito', 'diyan', 'doon', 'galit', 'ginagawa', 'gusto',
  'gutom', 'gawa', 'hindi', 'ho', 'ikaw', 'inyo', 'iyan', 'iyo', 'ito', 'iyon',
  'ka', 'kahapon', 'kailan', 'kanya', 'kanila', 'kayo', 'kita', 'ko', 'kuha',
  'kung', 'kwento', 'lamang', 'lang', 'lungkot', 'mabuti', 'mag', 'maganda',
  'mahal', 'malaman', 'meron', 'mo', 'muna', 'na', 'nag', 'naka', 'nakaka',
  'nakapag', 'naman', 'namin', 'natin', 'ng', 'mga', 'nga', 'ngayon', 'nila',
  'ninyo', 'niya', 'oo', 'opo', 'pa', 'pag', 'pagod', 'pang', 'pangit', 'paano',
  'pasensya', 'pero', 'po', 'pumunta', 'puro', 'raw', 'rin', 'sa', 'sagot',
  'sakit', 'salamat', 'sana', 'sayo', "sa'yo", 'siguro', 'sila', 'sino', 'siya',
  'talo', 'talaga', 'tanong', 'tawa', 'tayo', 'takot', 'usap', 'wala', 'yan',
  'yata',
  'ahora', 'amiga', 'amigo', 'buena', 'bueno', 'como', 'cuando', 'donde', 'eres',
  'esta', 'estas', 'estoy', 'gracias', 'hola', 'luego', 'mal', 'mala', 'malo',
  'manana', 'mañana', 'mucho', 'muy', 'nada', 'nosotros', 'nunca', 'otra', 'otro',
  'pero', 'por', 'porque', 'puede', 'puedes', 'quiero', 'quiere', 'siempre',
  'tambien', 'también', 'tengo', 'tienes', 'todo', 'todos', 'usted', 'ustedes',
  'allez', 'allons', 'amie', 'ami', 'aujourd', 'avec', 'avez', 'avons', 'bien',
  'bonjour', 'cette', 'ces', 'comment', 'dans', 'demain', 'des', 'dois', 'elle',
  'elles', 'faire', 'fait', 'hier', 'il', 'ils', 'je', 'leur', 'lui', 'maintenant',
  'merci', 'moi', 'mon', 'notre', 'nous', 'oui', 'pas', 'pour', 'pourquoi',
  'quand', 'que', 'qui', 'quoi', 'salut', 'sans', 'sont', 'suis', 'toi', 'ton',
  'tres', 'très', 'tu', 'va', 'vais', 'vas', 'veux', 'vont', 'votre', 'vous',
  'aber', 'alle', 'auch', 'auf', 'aus', 'bei', 'bitte', 'das', 'dein', 'dem',
  'den', 'der', 'des', 'dich', 'dir', 'du', 'ein', 'eine', 'einem', 'einen',
  'einer', 'eines', 'euch', 'euer', 'fur', 'für', 'gestern', 'habe', 'haben',
  'hast', 'hatte', 'heute', 'ich', 'ihr', 'ihre', 'im', 'ist', 'kein', 'keine',
  'mit', 'morgen', 'mich', 'mein', 'nach', 'nein', 'nicht', 'ohne', 'oder',
  'sein', 'sehr', 'sich', 'sind', 'sie', 'tschuss', 'tschüss', 'uber', 'über',
  'und', 'uns', 'unter', 'unser', 'vor', 'waren', 'wann', 'warum', 'wer', 'wie',
  'wir', 'wird', 'wurde', 'zu',
  'aku', 'apa', 'atau', 'bagaimana', 'belum', 'besok', 'bisa', 'bukan', 'dari',
  'dengan', 'dia', 'ingin', 'ini', 'itu', 'jika', 'kalau', 'kami', 'kamu',
  'kalian', 'kapan', 'karena', 'kasih', 'kita', 'mana', 'mau', 'mereka', 'pada',
  'paham', 'sekarang', 'siapa', 'sana', 'sedang', 'sini', 'sudah', 'tahu',
  'tanpa', 'teman', 'terima', 'tidak', 'untuk', 'yang',
]);

export function isEnglishOnlyReply(reply: string): boolean {
  const normalized = reply.normalize('NFC');
  for (const character of normalized) {
    if (LETTER.test(character) && !LATIN_SCRIPT.test(character)) {
      return false;
    }
  }

  const wordText = normalized
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const words = [...wordText.matchAll(WORD)].map(match =>
    match[0].replaceAll('’', "'"));
  if (words.length === 0) {
    return true;
  }

  let englishWords = 0;
  let nonEnglishMarkers = 0;
  for (const word of words) {
    if (ENGLISH_WORDS.has(word)) {
      englishWords += 1;
    }
    if (NON_ENGLISH_MARKERS.has(word)) {
      nonEnglishMarkers += 1;
    }
  }

  if (nonEnglishMarkers >= 2) {
    return false;
  }
  if (nonEnglishMarkers === 1 && englishWords === 0) {
    return false;
  }
  if (words.length >= 4 && englishWords === 0) {
    return false;
  }
  if (words.length >= 6 && englishWords / words.length < 0.2) {
    return false;
  }
  return true;
}

export function buildEnglishOnlyRetryInstruction(systemInstruction: string): string {
  return composeSystemInstruction(systemInstruction, ENGLISH_ONLY_RETRY_INSTRUCTION);
}
