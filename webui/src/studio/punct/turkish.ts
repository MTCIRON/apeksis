// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Turkish finishing touches on top of the punctuation model:
//  - sentence-initial capitals with Turkish casing (i -> İ, ı -> I),
//  - a full stop where the model ends a sentence without punctuation,
//  - the apostrophe between a proper noun and its inflectional suffix
//    ("istanbulda" -> "İstanbul'da", "ankaradır" -> "Ankara'dır").
//
// The model knows which words are proper nouns (it capitalises them) but not
// where the stem ends. Stems come from a small gazetteer and from the
// transcript itself: a capitalised word that also appears bare ("Ahmet")
// makes "Ahmetle" -> "Ahmet'le". Derivational suffixes and the plural take
// no apostrophe (TDK): "İstanbullu", "Ahmetler".

import type { WordMark } from "./punctuator";

const lower = (s: string) => s.toLocaleLowerCase("tr-TR");
const capitalise = (s: string) => (s ? s[0].toLocaleUpperCase("tr-TR") + s.slice(1) : s);

/** Case suffixes and the copula, written after an apostrophe. */
const SUFFIXES = new Set(
  [
    // locative, ablative, "-ki"
    "da de ta te dan den tan ten daki deki taki teki dakiler dekiler",
    // dative, accusative, genitive (with buffer letters)
    "a e ya ye ı i u ü yı yi yu yü ın in un ün nın nin nun nün",
    // instrumental, copula
    "la le yla yle dır dir dur dür tır tir tur tür",
  ]
    .join(" ")
    .split(" "),
);

/** Proper nouns that are never ordinary words: capitalised even if the model missed them. */
const PLACES = `adana adıyaman afyon afyonkarahisar amasya ankara antalya artvin balıkesir bilecik bingöl
bitlis burdur bursa çanakkale çankırı çorum denizli diyarbakır edirne elazığ erzincan erzurum eskişehir gaziantep
antep giresun gümüşhane hakkari hatay ısparta isparta mersin istanbul izmir kastamonu kayseri kırklareli kırşehir
kocaeli konya kütahya malatya manisa kahramanmaraş maraş mardin muğla nevşehir niğde sakarya samsun siirt sinop
sivas tekirdağ trabzon tunceli şanlıurfa urfa yozgat zonguldak aksaray bayburt karaman kırıkkale şırnak bartın
ardahan iğdır yalova karabük osmaniye düzce kadıköy beşiktaş üsküdar şişli beyoğlu bakırköy sarıyer maltepe
pendik ataşehir ümraniye beylikdüzü esenyurt bağcılar zeytinburnu eyüp küçükçekmece
büyükçekmece silivri çatalca beykoz çankaya keçiören yenimahalle karşıyaka bornova alsancak kapadokya
marmaris alanya fethiye türkiye almanya fransa ingiltere italya ispanya rusya amerika japonya
hindistan iran irak suriye yunanistan bulgaristan azerbaycan gürcistan ermenistan israil filistin ukrayna
polonya hollanda belçika avusturya isviçre isveç norveç danimarka finlandiya kanada meksika brezilya arjantin
avustralya pakistan afganistan katar kıbrıs portekiz macaristan romanya sırbistan bosna arnavutluk makedonya
kazakistan özbekistan türkmenistan kırgızistan endonezya malezya tayland vietnam nijerya cezayir tunus libya
avrupa asya afrika anadolu trakya karadeniz akdeniz marmara londra paris berlin madrid moskova tokyo
pekin brüksel viyana atina amsterdam atatürk
arnavutköy bahçelievler başakşehir bayrampaşa çekmeköy esenler eyüpsultan fatih gaziosmanpaşa güngören kağıthane
sancaktepe sultanbeyli sultangazi şile nişantaşı cihangir galata karaköy eminönü sultanahmet ortaköy etiler
mecidiyeköy florya yeşilköy ataköy tarabya emirgan çengelköy kuzguncuk beylerbeyi boğaziçi altındağ etimesgut
mamak sincan polatlı kızılay beypazarı buca çiğli gaziemir karabağlar bayraklı urla seferihisar torbalı ödemiş
bergama foça aliağa kuşadası didim ayvalık alaçatı assos bozcaada gökçeada datça göcek olimpos belek manavgat
akyaka uludağ erciyes palandöken pamukkale efes truva ürgüp avanos uçhisar safranbolu amasra uzungöl ayder
sümela hasankeyf halfeti harran göbeklitepe ihlara iskenderun tarsus ereğli inegöl gebze çorlu lüleburgaz
akhisar nazilli siverek cizre nusaybin doğubayazıt kızıltepe viranşehir elbistan ünye fatsa bafra turhal
merzifon edremit gemlik mudanya iznik bozüyük tosya dicle fırat kızılırmak yeşilırmak toros kaçkar munzur
çukurova mezopotamya balkanlar kafkasya sibirya iskandinavya antarktika okyanusya ortadoğu arabistan suudi
kolombiya venezuela ekvador bolivya paraguay uruguay peru şili küba jamaika haiti panama kosova karadağ
hırvatistan slovenya slovakya çekya litvanya letonya estonya belarus moldova irlanda izlanda lüksemburg andorra
monako malta moğolistan tacikistan bangladeş myanmar kamboçya filipinler singapur nepal tayvan laos kenya somali
ruanda angola zambiya uganda tanzanya etiyopya eritre madagaskar mozambik zimbabve namibya kamerun senegal
liberya kongo gabon ürdün lübnan kuveyt bahreyn umman iskoçya galler hersek zelanda selanik halep bağdat tahran
kahire iskenderiye kudüs beyrut bakü tiflis erivan taşkent semerkant buhara delhi şanghay seul sidney toronto
meksiko havana lizbon barselona milano napoli venedik floransa münih hamburg frankfurt köln zürih cenevre
marsilya prag budapeşte varşova bükreş sofya belgrad zagreb saraybosna üsküp kiev riga stockholm oslo kopenhag
helsinki dublin lahey dubai doha riyad mekke medine lefkoşa girne magosa gazze girit rodos`
  .split(/\s+/)
  .filter(Boolean);

/** Also place names, but common words too ("ordu" = army): only when the model capitalised them. */
const AMBIGUOUS = `van muş ordu batman tokat aydın bolu kars rize kilis uşak adalar konak kaş fas çin mısır ege
kore ağrı kartal tuzla bodrum çeşme avcılar roma bey hanım paşa hoca efendi
bebek moda ulus tire dikili kemer kalkan dalyan ani kazan tuna mali sudan yemen benin midilli sakız menemen
gölbaşı çarşamba kabil tiran kırım gine pazar bandırma göreme haliç nemrut taksim şam`
  .split(/\s+/)
  .filter(Boolean);

/** Common words that look like a place name + suffix ("kilise" = Kilis + e). */
const COMMON = new Set(["kilise", "vana"]);

const SAFE = new Set(PLACES);
const ALL_STEMS = [...PLACES, ...AMBIGUOUS];

/** Suffixes after a possessive at the end of a multi-word name: "Bölgesi'nde", "Gölü'nün", "Camii'dir". */
const AFTER_POSSESSIVE = `nın nin nun nün na ne nu nü nı ni nda nde ndan nden ndaki ndeki yla yle dır dir dur dür`
  .split(" ")
  .sort((a, b) => b.length - a.length);

/** Place names that end in a possessive themselves: "Kuşadası'na", "Beyoğlu'nda". */
const POSSESSIVE_PLACES = new Set(
  "kuşadası eminönü boğaziçi beylerbeyi beypazarı gölbaşı kocaeli zeytinburnu beylikdüzü nişantaşı beyoğlu".split(" "),
);

const SOFTEN: Record<string, string> = { k: "ğ", t: "d", p: "b", ç: "c" };
const VOWEL = /[aeıioöuü]/;

/** Buffer letters: "Ankara'ya", "Ankara'nın" after a vowel; "İzmir'e", "İzmir'in" after a consonant. */
function fits(stem: string, suffix: string): boolean {
  const vowelEnd = VOWEL.test(stem[stem.length - 1]);
  if (VOWEL.test(suffix[0])) return !vowelEnd;
  if (/^(y|n[ıiuü]n$)/.test(suffix)) return vowelEnd;
  return true;
}

/** Split `word` (lowercase) into a known stem + inflectional suffix, if possible. */
function splitProper(word: string, stems: Iterable<string>): { stem: string; suffix: string } | null {
  let best: { stem: string; suffix: string } | null = null;
  for (const stem of stems) {
    if (stem.length < 3 || (best && stem.length <= best.stem.length)) continue;
    if (word === stem) {
      best = { stem, suffix: "" };
      continue;
    }
    const rest = word.slice(stem.length);
    const ok = POSSESSIVE_PLACES.has(stem) ? AFTER_POSSESSIVE.includes(rest) : SUFFIXES.has(rest) && fits(stem, rest);
    if (word.startsWith(stem) && ok) {
      best = { stem, suffix: rest };
      continue;
    }
    // Consonant softening before a vowel: "pamuğun" = Pamuk + 'un.
    const soft = SOFTEN[stem[stem.length - 1]];
    if (soft) {
      const softened = stem.slice(0, -1) + soft;
      const after = word.slice(softened.length);
      if (word.startsWith(softened) && SUFFIXES.has(after) && /^[aeıioöuü]/.test(after)) {
        best = { stem, suffix: after };
      }
    }
  }
  return best;
}

/**
 * Last words of place, building, state and event names, which take an
 * apostrophe ("Van Gölü'nün"). Institutions do not (TDK): "Ankara Üniversitesinde".
 */
const NAME_HEADS = new Set(
  `gölü dağı dağları bölgesi köprüsü camii kalesi ovası çayı ırmağı nehri körfezi denizi boğazı adası adaları
yarımadası platosu havzası vadisi deltası yolu kilisesi sarayı kulesi kenti caddesi sokağı meydanı parkı
imparatorluğu devleti cumhuriyeti savaşı muharebesi antlaşması çağı devri ödülü festivali`.split(/\s+/),
);

/** Split the last word of a multi-word name after its possessive: "bölgesinde" -> bölgesi + nde. */
function splitCompound(word: string): { stem: string; suffix: string } | null {
  for (const suffix of AFTER_POSSESSIVE) {
    const stem = word.slice(0, -suffix.length);
    if (word.endsWith(suffix) && NAME_HEADS.has(stem)) return { stem, suffix };
  }
  return null;
}

/** Turn model marks into the final written words (one per transcript word). */
export function finishTurkish(marks: WordMark[]): string[] {
  // Capitalised words mid-sentence are names; remember them as stems, except
  // the inflected forms of another one ("Ahmetle" next to "Ahmet").
  const capitalised = new Set<string>();
  marks.forEach((m, i) => {
    const sentenceStart = i === 0 || marks[i - 1].sentenceEnd;
    if (m.capitalised && !sentenceStart && !splitProper(lower(m.text), ALL_STEMS)?.suffix) {
      const w = lower(m.text);
      // Not plurals ("Türkler") or languages ("Yunanca"): their suffixes take no apostrophe.
      if (w.length >= 3 && !SUFFIXES.has(w) && !/^.{3,}(l[ae]r|[cç][ae])$/.test(w)) capitalised.add(w);
    }
  });
  const learnedOnly = [...capitalised].filter(
    (w) => !SAFE.has(w) && !splitProper(w, [...capitalised].filter((c) => c !== w))?.suffix,
  );

  let previous = "";
  return marks.map((m, i) => {
    const w = lower(m.text);
    let text = m.text;

    const sentenceStart = i === 0 || marks[i - 1].sentenceEnd;
    if (COMMON.has(w)) return finish(m, i, sentenceStart ? capitalise(text) : text);
    const place = splitProper(w, PLACES);
    // Every sentence starts with a capital: that alone does not make a name.
    const ambiguous = m.capitalised && !sentenceStart ? splitProper(w, AMBIGUOUS) : null;
    let name = m.capitalised ? splitProper(w, learnedOnly) : null;
    // After another capitalised word, -ı/-i/-u/-ü is a possessive inside a
    // name ("Van Gölü", "Dünya Savaşı"), not an accusative ("Göl'ü"). A word
    // with a suffix or a comma ends a name ("Efes'in çağı").
    const insideName = i > 0 && !sentenceStart && marks[i - 1].capitalised && !/['.,?!]/.test(previous);
    if (insideName && name && /^[ıiuü]$/.test(name.suffix)) name = null;
    let hit = [place, ambiguous, name].reduce<{ stem: string; suffix: string } | null>(
      (a, b) => (b && (!a || b.stem.length > a.stem.length) ? b : a),
      null,
    );
    // The last word of a multi-word name the model capitalised: "Van Gölü'nün".
    const compound = insideName && m.capitalised ? splitCompound(w) : null;
    if (compound && hit !== place) hit = compound;
    if (hit) {
      // Keep the model's casing of the stem when it had one (e.g. all caps).
      // (A softened stem, "Pamuğ-un", is written in its dictionary form: "Pamuk'un".)
      const stemText = m.capitalised && w.startsWith(hit.stem) ? text.slice(0, hit.stem.length) : capitalise(hit.stem);
      text = hit.suffix ? `${capitalise(stemText)}'${hit.suffix}` : capitalise(stemText);
    }

    return finish(m, i, sentenceStart ? capitalise(text) : text);
  });

  function finish(m: WordMark, i: number, text: string): string {
    let post = m.post ?? "";
    if (m.sentenceEnd && !/[.?!…]$/.test(post)) post = ".";
    if (i === marks.length - 1 && !post) post = ".";
    previous = text + post;
    return previous;
  }
}

/** Strip punctuation and case so a transcript can be punctuated again. */
export function plainWord(text: string): string {
  return lower(text.replace(/['’]/g, "").replace(/[^\p{L}\p{N}-]/gu, ""));
}
