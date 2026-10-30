import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOtherIndustryValue,
  matchesEducationJapaneseLanguage,
  matchesEducationLanguage,
  matchesExistingPaper,
  matchesRoboticsLocalization,
  normalizeDoi,
  pickBestOption,
  pickPaperIndustry,
  titlesLikelySame,
  titleUsableForExistingMatch,
  sciSpaceCardMetaIncomplete,
  sciSpaceTldrIncomplete,
} from "./match.ts";

test("normalizeDoi: doi.org と裸の DOI を揃える", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1234/abc"), "10.1234/abc");
  assert.equal(normalizeDoi("doi:10.1234/abc"), "10.1234/abc");
  assert.equal(normalizeDoi("10.1234/abc."), "10.1234/abc");
});

test("titlesLikelySame: ファイル名由来の短い一致は 12 文字以上だけ", () => {
  assert.equal(
    titlesLikelySame(
      "The field equations for gravitation and electromagnetism",
      "The field equations for gravitation and electromagnetism",
    ),
    true,
  );
  assert.equal(titlesLikelySame("Short", "Something else"), false);
  assert.equal(
    titlesLikelySame(
      "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
      "Uber das Gravitationsfeld eines Massenpunktes",
    ),
    true,
  );
});

test("matchesExistingPaper: PDF 名称が同じときだけ一致（DOI・タイトルは見ない）", () => {
  const existing = [
    {
      title: "The field equations for gravitation and electromagnetism",
      doi: "10.1234/xyz",
      filename: "2601.04170v1.pdf",
    },
  ];
  assert.equal(
    matchesExistingPaper(existing, { doi: "https://doi.org/10.1234/xyz" }),
    null,
  );
  assert.equal(
    matchesExistingPaper(existing, {
      title: "The field equations for gravitation and electromagnetism",
    }),
    null,
  );
  assert.equal(
    matchesExistingPaper(existing, { filename: "2601.04170v1.pdf" })?.filename,
    "2601.04170v1.pdf",
  );
  assert.ok(matchesExistingPaper(existing, { filename: "2601.04170v1" }));
  assert.equal(matchesExistingPaper(existing, { filename: "unrelated.pdf" }), null);
});

test("titleUsableForExistingMatch: 数字ファイル名や短すぎるタイトルは使わない", () => {
  assert.equal(titleUsableForExistingMatch("1103899181", "1103899181.pdf"), false);
  assert.equal(
    titleUsableForExistingMatch(
      "A comprehensive survey of Schwarzschild's original papers: Schwarzschild's trick and Einstein's s(h)tick",
      "2312.01865v1.pdf",
    ),
    true,
  );
  assert.equal(
    titleUsableForExistingMatch(
      "The First Law of Robotics Revisited: A New Perspective on Autonomous Systems",
      "nihms690699.pdf",
    ),
    false,
  );
});

test("sciSpaceCardMetaIncomplete: ファイル名タイトル・空貼り付けはメタ未入り（TL;DR は見ない）", () => {
  assert.equal(
    sciSpaceCardMetaIncomplete({
      title: "Popper-Conjectures-Rwefutations-GrowthOfKnowledge",
      filename: "Popper-Conjectures-Rwefutations-GrowthOfKnowledge.pdf",
      filesPaste: "",
    }),
    true,
  );
  assert.equal(
    sciSpaceCardMetaIncomplete({
      title: "All objects and some questions",
      filename: "LineweaverPatel2023final.pdf",
      filesPaste: "2023⋅Charles H. Lineweaver",
    }),
    false,
  );
  assert.equal(
    titleUsableForExistingMatch("Commun. math. Phys. 43, 199—220 (1975)", "1103899181.pdf"),
    false,
  );
});

test("sciSpaceTldrIncomplete: 途中切れは説明に使わず、メタ完了とは別", () => {
  assert.equal(
    sciSpaceTldrIncomplete("inside the black hole where the Killing vector which represents time translations."),
    true,
  );
  assert.equal(
    sciSpaceTldrIncomplete(
      "We present an overview of the thermal history of the Universe and the sequence of objects that formed as it cooled from the Big Bang to the present day.",
    ),
    false,
  );
  assert.equal(
    sciSpaceCardMetaIncomplete({
      title: "Particle Creation by Black Holes",
      filename: "1103899181.pdf",
      filesPaste: "Particle Creation by Black Holes",
    }),
    false,
  );
});

test("pickBestOption: 最長一致", () => {
  assert.equal(
    pickBestOption(["物理", "物理化学", "生物"], "本研究は物理化学の手法を用いる"),
    "物理化学",
  );
  assert.equal(pickBestOption(["金融", "医療"], " unrelated astronomy text "), "");
});

const industries = [
  "AI・データ", "IT・通信", "半導体・電子デバイス", "エネルギー・資源", "宇宙・天文",
  "基礎科学（物理・数学）", "医療・ライフサイエンス", "農業・食品", "ロボティクス",
  "建設・インフラ", "経済・金融", "言語・教育", "その他",
];

const examples: [string, string][] = [
  ["machine learning with neural networks", "AI・データ"],
  ["telecom software", "IT・通信"],
  ["semiconductor photonic display 光電融合", "半導体・電子デバイス"],
  ["Review of Nanosheet Transistors Technology", "半導体・電子デバイス"],
  ["Sub-3nm GAA Nanosheet Reliability", "半導体・電子デバイス"],
  ["CMOS MOSFET transistor on 300mm wafer with EUV lithography", "半導体・電子デバイス"],
  ["gate-all-around chiplet packaging and interconnects", "半導体・電子デバイス"],
  ["ナノシートトランジスタの電気的特性", "半導体・電子デバイス"],
  ["SmartNIC and browser architecture in network systems", "IT・通信"],
  ["wave equation and quantum relativity in physics", "基礎科学（物理・数学）"],
  ["Large language models and LLM reasoning with transformers", "AI・データ"],
  ["astrophysics and supermassive black hole with space telescope", "宇宙・天文"],
  ["renewable energy", "エネルギー・資源"],
  ["galaxy astronomy", "宇宙・天文"],
  ["arXiv survey of Schwarzschild and Einstein general relativity", "基礎科学（物理・数学）"],
  ["数学の論文", "基礎科学（物理・数学）"],
  ["clinical genomics", "医療・ライフサイエンス"],
  ["Agricultural robot for crop monitoring on a farm", "農業・食品"],
  ["圃場の作物と農業の研究", "農業・食品"],
  ["Monitoring crops on farms", "農業・食品"],
  ["Farming automation", "農業・食品"],
  ["Mobile robot path tracking with pure pursuit and kinematics", "ロボティクス"],
  ["civil engineering construction", "建設・インフラ"],
  ["financial economics", "経済・金融"],
  ["language education", "言語・教育"],
];
for (const [text, expected] of examples) {
  test(`pickPaperIndustry: ${text}`, () => {
    assert.equal(pickPaperIndustry(industries, text), expected);
  });
}

for (const keyword of ["agricultur", "crop", "farm", "農業", "作物", "圃場"]) {
  test(`pickPaperIndustry: 農業キーワード ${keyword}`, () => {
    assert.equal(pickPaperIndustry(industries, keyword), "農業・食品");
  });
}
for (const keyword of ["robot", "ROS", "path tracking", "pure pursuit", "kinematics", "SLAM", "localization", "ロボット"]) {
  test(`pickPaperIndustry: ロボティクスキーワード ${keyword}`, () => {
    assert.equal(pickPaperIndustry(industries, keyword), "ロボティクス");
  });
}

test("pickPaperIndustry: 汎用的な学術語や未知の分野を既定分類へ寄せない", () => {
  for (const text of ["theory academic 論文 研究 arXiv research survey university", "hello world", "cross mail", ""]) {
    assert.equal(pickPaperIndustry(industries, text), "");
  }
});

test("pickPaperIndustry: 旧選択肢・自由入力値・その他を返さない", () => {
  const obsolete = ["医療・ヘルスケア", "金融・保険", "教育・研究", "製造業", "エネルギー・インフラ", "小売・流通", "メディア・エンタメ", "公共・非営利", "AI", "宇宙", "数学", "生命科学", "電子ペーパー"];
  for (const option of obsolete) {
    assert.equal(pickPaperIndustry([option, "その他"], option), "");
  }
  assert.equal(isOtherIndustryValue("その他（Home）"), true);
  assert.equal(pickPaperIndustry([], "robot"), "");
  assert.equal(pickPaperIndustry(["教育・研究", "ロボティクス"], "robot research"), "ロボティクス");
});

for (const keyword of [
  "transistor",
  "FET",
  "MOSFET",
  "CMOS",
  "nanosheet",
  "gate-all-around",
  "GAA",
  "chiplet",
  "lithography",
  "wafer",
  "トランジスタ",
  "ナノシート",
]) {
  test(`pickPaperIndustry: 半導体・電子デバイスキーワード ${keyword}`, () => {
    assert.equal(pickPaperIndustry(industries, keyword), "半導体・電子デバイス");
  });
}

test("pickPaperIndustry: GAA や FET が無関係な英単語の一部に当たらない", () => {
  const unrelatedWords = [
    "safety first in laboratory",
    "the team could defeat any rival",
    "fetch the remote dataset",
    "university cafeteria lunch menu",
    "prenatal and fetal development study",
    "buffet service optimization",
    "confident and lifetime achievement",
    "struggle against climate change",
    "marine algae growth under light",
    "megaampere pulsed power generator",
    "fauna of Madagascar",
    "satellite navigation system",
  ];
  for (const text of unrelatedWords) {
    assert.notEqual(pickPaperIndustry(industries, text), "半導体・電子デバイス", `should not match for: ${text}`);
  }
});

test("pickPaperIndustry: GAA や FET の境界一致（単体・ハイフン区切り）で半導体・電子デバイスを判定する", () => {
  for (const text of [
    "Sub-3nm GAA Nanosheet Reliability",
    "A study of novel FETs for low-power logic",
    "GAA-FET device scaling",
    "FinFET and nanosheet FET architectures",
  ]) {
    assert.equal(pickPaperIndustry(industries, text), "半導体・電子デバイス", `should match for: ${text}`);
  }
});

test("pickPaperIndustry: microprocessor / microphone 内の crop を農業と誤判定しない", () => {
  for (const text of ["A low-power microprocessor design", "microphone design"]) {
    assert.equal(pickPaperIndustry(industries, text), "");
  }
});

test("matchesEducationLanguage: プログラミング言語表現と自然言語表現を区別する", () => {
  assert.equal(matchesEducationLanguage("Design and implementation of the Rust programming language"), false);
  assert.equal(matchesEducationLanguage("Type inference for functional programming languages"), false);
  assert.equal(matchesEducationLanguage("A study on domain-specific languages in software engineering"), false);
  assert.equal(matchesEducationLanguage("Programming languages for parallel architectures"), false);
  assert.equal(matchesEducationLanguage("Natural language syntax and semantic parsing"), true);
  assert.equal(matchesEducationLanguage("Second language acquisition in education"), true);
  assert.equal(matchesEducationLanguage("A comparative study of natural language and programming language"), true);
  assert.equal(matchesEducationLanguage("Machine learning approaches to language acquisition"), true);
  assert.equal(matchesEducationLanguage("Machine learning models for natural language processing"), true);
});

test("matchesEducationJapaneseLanguage: プログラミング言語と自然言語を区別する", () => {
  assert.equal(matchesEducationJapaneseLanguage("プログラミング言語の型システム"), false);
  assert.equal(matchesEducationJapaneseLanguage("スクリプト言語の構文木"), false);
  assert.equal(matchesEducationJapaneseLanguage("自然言語の形態素解析"), true);
  assert.equal(matchesEducationJapaneseLanguage("プログラミング言語と自然言語の比較"), true);
});

test("matchesRoboticsLocalization: ソフトウェア翻訳とロボット自己位置推定を区別する", () => {
  assert.equal(matchesRoboticsLocalization("localization"), true);
  assert.equal(matchesRoboticsLocalization("Mobile robot localization using LiDAR"), true);
  assert.equal(matchesRoboticsLocalization("Visual SLAM and self-localization for mobile robots"), true);
  assert.equal(matchesRoboticsLocalization("Software localization for web applications"), false);
  assert.equal(matchesRoboticsLocalization("Localization of software user interfaces"), false);
  assert.equal(matchesRoboticsLocalization("Continuous localization in software engineering"), false);
  assert.equal(matchesRoboticsLocalization("ソフトウェアローカライゼーションの手法"), false);
  assert.equal(matchesRoboticsLocalization("Software architecture for mobile robot localization"), true);
  assert.equal(matchesRoboticsLocalization("Multi-sensor systems and robust localization"), true);
  assert.equal(matchesRoboticsLocalization("Applications of sound source localization"), true);
});

test("pickPaperIndustry: 4文脈（プログラミング言語・ソフトウェア翻訳・自然言語・自己位置推定）の回帰テスト", () => {
  // 1. プログラミング言語文脈 -> IT・通信（言語・教育への誤判定を防ぐ）
  const plExamples = [
    "Design and implementation of the Rust programming language",
    "Type inference for functional programming languages",
    "A domain-specific programming language for distributed computing",
    "プログラミング言語の構文解析と型検査アルゴリズム",
    "新世代プログラミング言語におけるメモリ安全性",
  ];
  for (const text of plExamples) {
    assert.equal(pickPaperIndustry(industries, text), "IT・通信", `PL context should match IT・通信: ${text}`);
  }

  // 2. ソフトウェア翻訳文脈 -> IT・通信（ロボティクスへの誤判定を防ぐ）
  const localizationExamples = [
    "Software localization for global web applications",
    "Best practices for localization in software engineering",
    "Localization of software user interfaces and menus",
    "Continuous software localization and internationalization workflows",
    "ソフトウェアローカライゼーションの自動化に関する考察",
    "ソフトウェア翻訳と多言語対応支援ツールの評価",
  ];
  for (const text of localizationExamples) {
    assert.equal(pickPaperIndustry(industries, text), "IT・通信", `Software localization context should match IT・通信: ${text}`);
  }

  // 3. 自然言語文脈 -> 言語・教育
  const nlExamples = [
    "Natural language understanding and syntactic analysis",
    "Natural language acquisition in early childhood education",
    "Syntactic structures in natural languages",
    "自然言語処理における統語構造の解析",
    "自然言語の意味論と語学教育への応用",
    "Statistical models for language acquisition",
  ];
  for (const text of nlExamples) {
    assert.equal(pickPaperIndustry(industries, text), "言語・教育", `NL context should match 言語・教育: ${text}`);
  }

  // 4. ロボット自己位置推定文脈 -> ロボティクス
  const roboticsExamples = [
    "Mobile robot localization using LiDAR and sensor fusion",
    "Visual SLAM and self-localization for indoor mobile robots",
    "Indoor robot localization and mapping in dynamic environments",
    "Software architecture for mobile robot localization",
    "自律移動ロボットの自己位置推定アルゴリズム",
    "移動ロボットの自己位置推定と環境地図作成",
    "Multi-sensor systems and robust localization",
    "Applications of sound source localization",
  ];
  for (const text of roboticsExamples) {
    assert.equal(pickPaperIndustry(industries, text), "ロボティクス", `Robotics localization context should match ロボティクス: ${text}`);
  }
});

test("pickPaperIndustry: 単独の programming が数理計画法や教育を IT・通信 に寄せない", () => {
  // 線形計画法等の最適化問題（農業・食品の論文）が IT・通信 にならない
  assert.equal(pickPaperIndustry(industries, "Linear programming for crop planning on farms"), "農業・食品");
  // プログラミング教育が IT・通信 ではなく 言語・教育 になる
  assert.equal(pickPaperIndustry(industries, "Programming education for children in schools"), "言語・教育");
});
