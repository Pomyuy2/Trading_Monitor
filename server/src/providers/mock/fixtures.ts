/**
 * Fixture data for MockProvider. All values are FAKE (plausible, not real) and
 * the UI labels them "Mock data". Some symbols deliberately leave fields
 * null so the "—" / missing-data states can be seen.
 */
import type { Lang, Sentiment } from '@tm/shared';

type Bi = Record<Lang, string>;

export interface MockGuidanceField {
  value: Bi;
  quote: string; // supporting quote, kept in the source language (English)
}

export interface MockCompany {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  price: number;
  prevClose: number;
  dailyVol: number; // daily volatility (fraction)
  fiveYearGrowth: number; // price now / price 5y ago
  sharesOut: number; // shares outstanding
  avgVolume: number | null;
  peTTM: number | null;
  week52High: number;
  week52Low: number;
  dividendYield: number | null; // percent
  profile: {
    description: string | null;
    ceo: { name: string; since: number | null } | null;
    cfo: { name: string; since: number | null } | null;
    hq: string | null;
    founded: number | null;
    employees: number | null;
    website: string | null;
  };
  estimates: { fiscalYear: number; revenueAvg: number | null; epsAvg: number | null; analystCount: number | null } | null;
  priceTargets: { low: number; avg: number; high: number } | null;
  ratings: { buy: number; hold: number; sell: number } | null;
  nextEarnings: string | null;
  guidance: {
    fiscalYear: number;
    sourceTitle: string;
    sourceDate: string;
    revenueGuidance: MockGuidanceField | null;
    epsGuidance: MockGuidanceField | null;
    capexBudget: MockGuidanceField | null;
    rndBudget: MockGuidanceField | null;
    priorities: (MockGuidanceField | null)[];
  } | null;
  news: { headline: string; snippet: string; sentiment: Sentiment; hoursAgo: number }[] | null;
  summaryTopics: { drivers: Bi; risk: Bi } | null;
}

export const MOCK_SOURCES = ['Mock Wire', 'Demo Markets Daily', 'Sample Street Journal', 'Fixture Finance', 'Test Ticker News'];

export const COMPANIES: MockCompany[] = [
  {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    exchange: 'NASDAQ',
    type: 'Common Stock',
    price: 268.42,
    prevClose: 265.1,
    dailyVol: 0.016,
    fiveYearGrowth: 2.2,
    sharesOut: 14.8e9,
    avgVolume: 52_400_000,
    peTTM: 35.8,
    week52High: 277.32,
    week52Low: 169.21,
    dividendYield: 0.39,
    profile: {
      description: 'Designs and sells iPhone, Mac, iPad, wearables and a growing services business including the App Store, iCloud and Apple Music.',
      ceo: { name: 'Tim Cook', since: 2011 },
      cfo: { name: 'Kevan Parekh', since: 2025 },
      hq: 'Cupertino, California, USA',
      founded: 1976,
      employees: 166_000,
      website: 'https://www.apple.com',
    },
    estimates: { fiscalYear: 2027, revenueAvg: 455_000_000_000, epsAvg: 8.42, analystCount: 41 },
    priceTargets: { low: 205, avg: 287.5, high: 345 },
    ratings: { buy: 27, hold: 12, sell: 2 },
    nextEarnings: '2027-01-28',
    guidance: {
      fiscalYear: 2027,
      sourceTitle: 'Q4 FY2026 earnings call transcript',
      sourceDate: '2026-10-29',
      revenueGuidance: {
        value: { en: 'Low- to mid-single-digit growth in the December quarter', th: 'เติบโตในระดับเลขหลักเดียวช่วงต่ำถึงกลาง ในไตรมาสเดือนธันวาคม' },
        quote: '"We expect our December quarter total company revenue to grow low to mid single digits year over year."',
      },
      epsGuidance: null,
      capexBudget: {
        value: { en: 'About $14B, weighted to AI data centers', th: 'ประมาณ 14 พันล้านดอลลาร์ เน้นศูนย์ข้อมูล AI' },
        quote: '"We continue to invest in our data center footprint, and expect capital expenditures of roughly fourteen billion dollars."',
      },
      rndBudget: {
        value: { en: 'R&D to grow faster than revenue', th: 'ค่าใช้จ่าย R&D เติบโตเร็วกว่ารายได้' },
        quote: '"We expect R&D to continue growing at a faster rate than revenue as we invest in Apple Intelligence."',
      },
      priorities: [
        { value: { en: 'Expand Apple Intelligence features across devices', th: 'ขยายฟีเจอร์ Apple Intelligence ไปทุกอุปกรณ์' }, quote: '"Apple Intelligence remains our top priority across every product line."' },
        { value: { en: 'Grow services revenue and paid subscriptions', th: 'เพิ่มรายได้บริการและการสมัครสมาชิกแบบชำระเงิน' }, quote: '"Services set another all-time revenue record and we see a long runway ahead."' },
        { value: { en: 'Diversify manufacturing to India and Vietnam', th: 'กระจายฐานการผลิตไปอินเดียและเวียดนาม' }, quote: '"We are continuing to diversify our supply chain, with more production in India and Vietnam."' },
      ],
    },
    news: [
      { headline: 'Apple services revenue hits record as App Store spending climbs', snippet: 'Services grew double digits for the quarter, offsetting softer Mac sales.', sentiment: 'positive', hoursAgo: 2 },
      { headline: 'Analysts lift Apple price targets after strong iPhone upgrade cycle', snippet: 'Several brokers raised targets citing demand for the latest iPhone lineup.', sentiment: 'positive', hoursAgo: 5 },
      { headline: 'EU regulators open new probe into Apple app store fees', snippet: 'The investigation focuses on fees charged to developers using alternative payments.', sentiment: 'negative', hoursAgo: 8 },
      { headline: 'Apple supplier signals steady component orders into next year', snippet: 'An Asian component maker said orders were in line with seasonal patterns.', sentiment: 'neutral', hoursAgo: 11 },
      { headline: 'China smartphone market share slips for Apple in October', snippet: 'Local rivals gained share amid aggressive pricing.', sentiment: 'negative', hoursAgo: 15 },
      { headline: 'What to watch in Apple’s next product event', snippet: 'Investors are focused on AI features and pricing.', sentiment: 'neutral', hoursAgo: 20 },
    ],
    summaryTopics: {
      drivers: { en: 'record services revenue and a strong iPhone upgrade cycle', th: 'รายได้บริการทำสถิติสูงสุดและรอบการเปลี่ยน iPhone ที่แข็งแกร่ง' },
      risk: { en: 'a new EU probe into App Store fees and slipping share in China', th: 'การสอบสวนค่าธรรมเนียม App Store ครั้งใหม่ของ EU และส่วนแบ่งตลาดจีนที่ลดลง' },
    },
  },
  {
    symbol: 'MSFT',
    name: 'Microsoft Corporation',
    exchange: 'NASDAQ',
    type: 'Common Stock',
    price: 512.3,
    prevClose: 515.88,
    dailyVol: 0.014,
    fiveYearGrowth: 2.4,
    sharesOut: 7.43e9,
    avgVolume: 21_300_000,
    peTTM: 37.2,
    week52High: 555.45,
    week52Low: 344.79,
    dividendYield: 0.68,
    profile: {
      description: 'Develops cloud computing (Azure), productivity software (Microsoft 365), Windows, gaming (Xbox) and AI services.',
      ceo: { name: 'Satya Nadella', since: 2014 },
      cfo: { name: 'Amy Hood', since: 2013 },
      hq: 'Redmond, Washington, USA',
      founded: 1975,
      employees: 228_000,
      website: 'https://www.microsoft.com',
    },
    estimates: { fiscalYear: 2027, revenueAvg: 371_000_000_000, epsAvg: 17.95, analystCount: 48 },
    priceTargets: { low: 480, avg: 625, high: 720 },
    ratings: { buy: 45, hold: 4, sell: 0 },
    nextEarnings: '2027-01-27',
    guidance: {
      fiscalYear: 2027,
      sourceTitle: 'Q1 FY2027 earnings call transcript',
      sourceDate: '2026-10-28',
      revenueGuidance: {
        value: { en: 'Double-digit revenue growth for FY2027', th: 'รายได้เติบโตเลขสองหลักในปีงบประมาณ 2027' },
        quote: '"We continue to expect double-digit revenue and operating income growth for the full fiscal year."',
      },
      epsGuidance: null,
      capexBudget: {
        value: { en: 'Capex to rise sequentially; FY2027 growth above FY2026', th: 'งบลงทุนเพิ่มขึ้นต่อเนื่อง อัตราเติบโตปี 2027 สูงกว่าปี 2026' },
        quote: '"We now expect FY27 capital expenditure growth to be higher than FY26."',
      },
      rndBudget: null,
      priorities: [
        { value: { en: 'Scale Azure AI infrastructure capacity', th: 'ขยายกำลังโครงสร้างพื้นฐาน Azure AI' }, quote: '"We remain capacity constrained and are bringing more AI capacity online every quarter."' },
        { value: { en: 'Grow Copilot adoption across Microsoft 365', th: 'เพิ่มการใช้งาน Copilot ใน Microsoft 365' }, quote: '"Copilot seats grew faster than any prior Microsoft 365 suite."' },
        { value: { en: 'Improve operating margins despite AI spend', th: 'ปรับปรุงอัตรากำไรจากการดำเนินงานแม้มีการลงทุน AI' }, quote: '"We are focused on operating leverage even as we invest."' },
      ],
    },
    news: [
      { headline: 'Microsoft Azure growth tops estimates on AI demand', snippet: 'Cloud revenue rose faster than expected, driven by AI workloads.', sentiment: 'positive', hoursAgo: 3 },
      { headline: 'Microsoft signals higher capex as data center build-out accelerates', snippet: 'Investors weighed rising spending against cloud growth.', sentiment: 'negative', hoursAgo: 6 },
      { headline: 'Copilot pricing changes rolled out for enterprise customers', snippet: 'The company adjusted bundles for large business plans.', sentiment: 'neutral', hoursAgo: 12 },
      { headline: 'Gaming revenue dips as hardware sales slow', snippet: 'Xbox content held up while console sales fell.', sentiment: 'negative', hoursAgo: 18 },
      { headline: 'Microsoft expands sovereign cloud offering in Europe', snippet: 'New regions target regulated industries.', sentiment: 'positive', hoursAgo: 22 },
    ],
    summaryTopics: {
      drivers: { en: 'Azure growth beating estimates on AI demand', th: 'การเติบโตของ Azure ที่ดีกว่าคาดจากความต้องการ AI' },
      risk: { en: 'rising capital spending on data centers weighing on margins', th: 'งบลงทุนศูนย์ข้อมูลที่สูงขึ้นซึ่งกดดันอัตรากำไร' },
    },
  },
  {
    symbol: 'NVDA',
    name: 'NVIDIA Corporation',
    exchange: 'NASDAQ',
    type: 'Common Stock',
    price: 198.64,
    prevClose: 192.27,
    dailyVol: 0.029,
    fiveYearGrowth: 12,
    sharesOut: 24.3e9,
    avgVolume: 188_000_000,
    peTTM: 54.1,
    week52High: 212.19,
    week52Low: 86.62,
    dividendYield: 0.02,
    profile: {
      description: 'Designs GPUs and accelerated computing platforms for AI data centers, gaming, professional visualization and automotive.',
      ceo: { name: 'Jensen Huang', since: 1993 },
      cfo: { name: 'Colette Kress', since: 2013 },
      hq: 'Santa Clara, California, USA',
      founded: 1993,
      employees: 36_000,
      website: 'https://www.nvidia.com',
    },
    estimates: { fiscalYear: 2027, revenueAvg: 312_000_000_000, epsAvg: 7.48, analystCount: 57 },
    priceTargets: { low: 150, avg: 245, high: 320 },
    ratings: { buy: 52, hold: 5, sell: 1 },
    nextEarnings: '2026-11-18',
    guidance: {
      fiscalYear: 2027,
      sourceTitle: 'Q2 FY2027 earnings call transcript',
      sourceDate: '2026-08-26',
      revenueGuidance: {
        value: { en: 'Q3 revenue of about $54B, ±2%', th: 'รายได้ไตรมาส 3 ประมาณ 54 พันล้านดอลลาร์ ±2%' },
        quote: '"Revenue is expected to be fifty-four billion dollars, plus or minus two percent."',
      },
      epsGuidance: null,
      capexBudget: null,
      rndBudget: {
        value: { en: 'Operating expenses to grow in the high-30s % for the year', th: 'ค่าใช้จ่ายดำเนินงานทั้งปีเติบโตราว 35–39%' },
        quote: '"We expect full-year operating expense growth to be in the high thirties percent range."',
      },
      priorities: [
        { value: { en: 'Ramp next-generation data center platform', th: 'เร่งการผลิตแพลตฟอร์มศูนย์ข้อมูลรุ่นถัดไป' }, quote: '"The ramp of our next platform is proceeding on schedule."' },
        { value: { en: 'Expand networking and full-stack AI systems', th: 'ขยายธุรกิจเครือข่ายและระบบ AI แบบครบวงจร' }, quote: '"Networking is now a multibillion-dollar business growing faster than compute."' },
        { value: { en: 'Grow sovereign AI customer base', th: 'ขยายฐานลูกค้า AI ระดับประเทศ' }, quote: '"Sovereign AI is a significant growth opportunity."' },
      ],
    },
    news: [
      { headline: 'Nvidia jumps as hyperscalers raise AI spending plans', snippet: 'Big cloud providers signalled higher data center budgets for next year.', sentiment: 'positive', hoursAgo: 1 },
      { headline: 'Export rule changes add uncertainty for Nvidia’s China sales', snippet: 'New licensing requirements could delay some shipments.', sentiment: 'negative', hoursAgo: 4 },
      { headline: 'Nvidia earnings preview: expectations run high', snippet: 'Options imply a large post-earnings move.', sentiment: 'neutral', hoursAgo: 9 },
      { headline: 'New partnership expands Nvidia’s automotive platform', snippet: 'An automaker will use the platform in upcoming models.', sentiment: 'positive', hoursAgo: 14 },
      { headline: 'Rivals step up competition in AI accelerators', snippet: 'Custom chips from cloud providers gain traction.', sentiment: 'negative', hoursAgo: 21 },
    ],
    summaryTopics: {
      drivers: { en: 'hyperscalers raising AI spending plans ahead of earnings', th: 'ผู้ให้บริการคลาวด์รายใหญ่เพิ่มแผนการลงทุน AI ก่อนประกาศงบ' },
      risk: { en: 'export-rule uncertainty for China sales and rising competition', th: 'ความไม่แน่นอนของกฎการส่งออกไปจีนและการแข่งขันที่เพิ่มขึ้น' },
    },
  },
  {
    symbol: 'TSLA',
    name: 'Tesla, Inc.',
    exchange: 'NASDAQ',
    type: 'Common Stock',
    price: 412.8,
    prevClose: 428.51,
    dailyVol: 0.037,
    fiveYearGrowth: 1.6,
    sharesOut: 3.22e9,
    avgVolume: 96_000_000,
    peTTM: 198.4,
    week52High: 488.54,
    week52Low: 214.25,
    dividendYield: null,
    profile: {
      description: 'Makes electric vehicles, battery energy storage and solar products, and develops autonomous-driving software.',
      ceo: { name: 'Elon Musk', since: 2008 },
      cfo: { name: 'Vaibhav Taneja', since: 2023 },
      hq: 'Austin, Texas, USA',
      founded: 2003,
      employees: 125_665,
      website: 'https://www.tesla.com',
    },
    estimates: { fiscalYear: 2027, revenueAvg: 118_000_000_000, epsAvg: 2.85, analystCount: 44 },
    priceTargets: { low: 120, avg: 365, high: 600 },
    ratings: { buy: 18, hold: 15, sell: 10 },
    nextEarnings: '2027-01-27',
    guidance: {
      fiscalYear: 2027,
      sourceTitle: 'Q3 2026 earnings call transcript',
      sourceDate: '2026-10-21',
      revenueGuidance: null,
      epsGuidance: null,
      capexBudget: {
        value: { en: 'Capex above $11B in 2027', th: 'งบลงทุนมากกว่า 11 พันล้านดอลลาร์ในปี 2027' },
        quote: '"We expect capital expenditures to exceed eleven billion dollars next year."',
      },
      rndBudget: null,
      priorities: [
        { value: { en: 'Expand robotaxi service to more cities', th: 'ขยายบริการโรโบแท็กซี่ไปยังเมืองอื่นเพิ่มเติม' }, quote: '"We plan to expand ride-hailing to several more metro areas."' },
        { value: { en: 'Start volume production of lower-cost models', th: 'เริ่มผลิตรุ่นราคาประหยัดในปริมาณมาก' }, quote: '"More affordable models remain on track for volume production."' },
        { value: { en: 'Scale energy storage deployments', th: 'ขยายการติดตั้งระบบกักเก็บพลังงาน' }, quote: '"Energy storage deployments hit another record."' },
      ],
    },
    news: [
      { headline: 'Tesla shares slide after delivery numbers miss forecasts', snippet: 'Quarterly deliveries fell short of consensus.', sentiment: 'negative', hoursAgo: 2 },
      { headline: 'Tesla energy storage deployments reach record', snippet: 'The energy unit continued to grow strongly.', sentiment: 'positive', hoursAgo: 7 },
      { headline: 'Robotaxi expansion plans draw regulatory questions', snippet: 'Officials asked for more safety data.', sentiment: 'negative', hoursAgo: 10 },
      { headline: 'Price cuts in Europe aim to revive demand', snippet: 'Analysts debate the impact on margins.', sentiment: 'neutral', hoursAgo: 16 },
    ],
    summaryTopics: {
      drivers: { en: 'a delivery miss partly offset by record energy storage', th: 'ยอดส่งมอบต่ำกว่าคาด แต่ถูกชดเชยบางส่วนด้วยธุรกิจกักเก็บพลังงานที่ทำสถิติ' },
      risk: { en: 'regulatory questions over robotaxi expansion and margin pressure from price cuts', th: 'คำถามด้านกฎระเบียบต่อการขยายโรโบแท็กซี่ และแรงกดดันต่ออัตรากำไรจากการลดราคา' },
    },
  },
  // ---- Partial fixtures (some fields intentionally missing) ----
  partial('AMZN', 'Amazon.com, Inc.', 236.2, 233.95, 0.02, 2.8, 10.7e9, 44_000_000, 38.4, 258.6, 161.38, null, {
    description: 'Online retail, Amazon Web Services cloud computing, advertising and subscription services.',
    ceo: { name: 'Andy Jassy', since: 2021 },
    cfo: { name: 'Brian Olsavsky', since: 2015 },
    hq: 'Seattle, Washington, USA',
    founded: 1994,
    employees: 1_556_000,
    website: 'https://www.amazon.com',
  }, { fiscalYear: 2027, revenueAvg: 795_000_000_000, epsAvg: 7.9, analystCount: 62 }, { low: 200, avg: 285, high: 340 }, { buy: 60, hold: 4, sell: 0 }, '2027-02-04'),
  partial('GOOGL', 'Alphabet Inc.', 284.5, 281.1, 0.019, 3.1, 12.1e9, 35_000_000, 27.3, 291.0, 140.53, 0.3, {
    description: 'Parent of Google: search, YouTube, Android, Google Cloud and other bets including Waymo.',
    ceo: { name: 'Sundar Pichai', since: 2015 },
    cfo: null,
    hq: 'Mountain View, California, USA',
    founded: 1998,
    employees: 187_000,
    website: 'https://abc.xyz',
  }, { fiscalYear: 2027, revenueAvg: 455_000_000_000, epsAvg: 11.2, analystCount: 55 }, { low: 210, avg: 310, high: 360 }, { buy: 47, hold: 9, sell: 0 }, '2027-02-02'),
  partial('META', 'Meta Platforms, Inc.', 702.1, 709.4, 0.024, 2.3, 2.51e9, 13_500_000, 27.9, 796.25, 479.8, 0.29, {
    description: 'Facebook, Instagram, WhatsApp and Threads, plus Reality Labs hardware and AI research.',
    ceo: { name: 'Mark Zuckerberg', since: 2004 },
    cfo: { name: 'Susan Li', since: 2022 },
    hq: 'Menlo Park, California, USA',
    founded: 2004,
    employees: 76_800,
    website: 'https://about.meta.com',
  }, null, { low: 605, avg: 860, high: 1100 }, { buy: 55, hold: 7, sell: 1 }, '2027-01-27'),
  partial('JPM', 'JPMorgan Chase & Co.', 309.4, 307.15, 0.013, 2.0, 2.75e9, 9_100_000, 15.4, 318.01, 202.16, 1.94, {
    description: 'Global bank: consumer and community banking, corporate and investment banking, and asset and wealth management.',
    ceo: { name: 'Jamie Dimon', since: 2005 },
    cfo: { name: 'Jeremy Barnum', since: 2021 },
    hq: 'New York, New York, USA',
    founded: 1799,
    employees: 317_000,
    website: 'https://www.jpmorganchase.com',
  }, { fiscalYear: 2027, revenueAvg: 184_000_000_000, epsAvg: 21.3, analystCount: 24 }, { low: 255, avg: 330, high: 375 }, { buy: 15, hold: 9, sell: 1 }, '2027-01-13'),
  partial('AMD', 'Advanced Micro Devices, Inc.', 248.9, 241.6, 0.033, 2.6, 1.62e9, 61_000_000, 142.7, 267.08, 76.48, null, {
    description: 'Designs CPUs, GPUs and adaptive chips for data centers, PCs, gaming consoles and embedded systems.',
    ceo: { name: 'Lisa Su', since: 2014 },
    cfo: { name: 'Jean Hu', since: 2022 },
    hq: 'Santa Clara, California, USA',
    founded: 1969,
    employees: 28_000,
    website: 'https://www.amd.com',
  }, { fiscalYear: 2027, revenueAvg: 46_500_000_000, epsAvg: 6.4, analystCount: 45 }, null, { buy: 36, hold: 10, sell: 0 }, '2027-02-03'),
  partial('NFLX', 'Netflix, Inc.', 112.4, 111.05, 0.021, 2.1, 4.25e9, null, 46.1, 134.12, 82.11, null, {
    description: 'Subscription streaming service for TV series, films and games, with a growing advertising tier.',
    ceo: { name: 'Ted Sarandos, Greg Peters', since: 2023 },
    cfo: { name: 'Spencer Neumann', since: 2019 },
    hq: 'Los Gatos, California, USA',
    founded: 1997,
    employees: null,
    website: 'https://www.netflix.com',
  }, { fiscalYear: 2027, revenueAvg: 51_200_000_000, epsAvg: null, analystCount: 38 }, { low: 85, avg: 135, high: 160 }, null, null),
];

function partial(
  symbol: string,
  name: string,
  price: number,
  prevClose: number,
  dailyVol: number,
  fiveYearGrowth: number,
  sharesOut: number,
  avgVolume: number | null,
  peTTM: number | null,
  week52High: number,
  week52Low: number,
  dividendYield: number | null,
  profile: MockCompany['profile'],
  estimates: MockCompany['estimates'],
  priceTargets: MockCompany['priceTargets'],
  ratings: MockCompany['ratings'],
  nextEarnings: string | null,
): MockCompany {
  return {
    symbol, name, exchange: symbol === 'JPM' ? 'NYSE' : 'NASDAQ', type: 'Common Stock',
    price, prevClose, dailyVol, fiveYearGrowth, sharesOut, avgVolume, peTTM, week52High, week52Low, dividendYield,
    profile, estimates, priceTargets, ratings, nextEarnings,
    guidance: null,
    news: null,
    summaryTopics: null,
  };
}

/** Generic headlines for companies without custom news. `{n}` = short company name. */
export const GENERIC_NEWS: { headline: string; snippet: string; sentiment: Sentiment; hoursAgo: number }[] = [
  { headline: '{n} shares rise as analysts lift price targets', snippet: 'Brokers pointed to steady demand and margin improvement.', sentiment: 'positive', hoursAgo: 3 },
  { headline: 'Regulators review {n} business practices', snippet: 'The review is at an early stage, according to people familiar.', sentiment: 'negative', hoursAgo: 7 },
  { headline: 'What to watch ahead of {n}’s next earnings report', snippet: 'Guidance and margins are in focus.', sentiment: 'neutral', hoursAgo: 12 },
  { headline: '{n} expands partnership to speed up AI rollout', snippet: 'The deal covers cloud and software integration.', sentiment: 'positive', hoursAgo: 17 },
  { headline: 'Options traders brace for bigger swings in {n}', snippet: 'Implied volatility rose this week.', sentiment: 'neutral', hoursAgo: 23 },
];

export const GENERIC_TOPICS = {
  drivers: { en: 'analyst target upgrades and a new AI partnership', th: 'การปรับเพิ่มราคาเป้าหมายของนักวิเคราะห์และความร่วมมือด้าน AI ใหม่' },
  risk: { en: 'an early-stage regulatory review', th: 'การตรวจสอบของหน่วยงานกำกับดูแลที่อยู่ในช่วงเริ่มต้น' },
};
