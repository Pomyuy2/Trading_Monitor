import {
  loadRealMarketData,
  runRigorousValidation,
} from '../src/analysis/statistical-validation.js';

async function main() {
  console.log('================================================================================');
  console.log('       TRADING MONITOR — ADAPTIVE S/R V2 STATISTICAL VALIDATION SUITE          ');
  console.log('================================================================================\n');

  const fixtures = loadRealMarketData();

  const dailySymbols = ['SPY', 'AAPL', 'NVDA', 'TSLA'];
  const allResults: Record<string, any> = {};

  for (const sym of dailySymbols) {
    const dataset = fixtures.daily[sym];
    console.log(`\n>>> Running Rigorous Validation on ${sym} Daily (${dataset.barCount} bars, ${dataset.startDate} to ${dataset.endDate})`);
    const val = runRigorousValidation(sym, dataset.candles, {
      trainRatio: 0.60,
      embargoBars: 10,
    });
    allResults[sym] = val;

    console.log(`\n--- [1] Dataset Provenance: ${sym} ---`);
    console.log(`Feed: ${dataset.source} | Bars: ${dataset.barCount} | Range: ${dataset.startDate} to ${dataset.endDate}`);
    console.log(`Train Interval (60%): 0 to 300 (${dataset.candles[0].time} - ${dataset.candles[300].time})`);
    console.log(`Embargo Purge Gap: 301 to 310 (10 bars)`);
    console.log(`Held-Out Test Interval (40%): 311 to ${dataset.barCount - 1} (${dataset.candles[311].time} - ${dataset.candles[dataset.barCount - 1].time})`);

    console.log(`\n--- [2] Held-Out Test Set Performance (Chronologically Out-of-Sample) ---`);
    console.table(
      Object.values(val.heldOutTest).map((m) => ({
        Candidate: m.candidate,
        Levels: m.totalCandidateLevels,
        Touches: m.totalTouches,
        'Touch Rate': `${(m.touchRate * 100).toFixed(1)}%`,
        'Bounce Rate': `${(m.confirmedBounceRate * 100).toFixed(1)}%`,
        'MBB-10 95% CI': `[${(m.bounceRateCI95_MBB10[0] * 100).toFixed(1)}%, ${(m.bounceRateCI95_MBB10[1] * 100).toFixed(1)}%]`,
        'Breakout Rate': `${(m.confirmedBreakoutRate * 100).toFixed(1)}%`,
        'False Breakout': `${(m.falseBreakoutRate * 100).toFixed(1)}%`,
        'Rejection Rate': `${(m.rejectionRate * 100).toFixed(1)}%`,
        Coverage: `${(m.opportunityCoverage * 100).toFixed(1)}%`,
        'Zone Churn': `${(m.zoneChurnRate * 100).toFixed(1)}%`,
        'MFE/MAE': m.mfeMaeRatio.toFixed(2),
        N_eff: m.nEff,
      })),
    );

    console.log(`\n--- [3] Dependence-Aware Paired Difference Test (V2-Full vs V1) on Held-Out Test ---`);
    console.log(`Mean V1 Bounce Rate: ${(val.pairedDiffHeldOut.v1Mean * 100).toFixed(2)}%`);
    console.log(`Mean V2 Bounce Rate: ${(val.pairedDiffHeldOut.v2Mean * 100).toFixed(2)}%`);
    console.log(`Paired Delta (V2 - V1): ${(val.pairedDiffHeldOut.deltaMean * 100).toFixed(2)}%`);
    console.log('Block Bootstrap Sensitivity on Paired Delta:');
    console.table(
      Object.entries(val.pairedDiffHeldOut.mbbResults).map(([B, res]) => ({
        'Block Size (B)': B,
        'Bootstrap SE': `${(res.se * 100).toFixed(2)}%`,
        '95% CI on Delta': `[${(res.ci95[0] * 100).toFixed(1)}%, ${(res.ci95[1] * 100).toFixed(1)}%]`,
        N_eff: res.nEff,
      })),
    );
    console.log(`Studentized Paired p-value (B=10): p = ${val.pairedDiffHeldOut.pValStudentized}`);

    console.log(`\n--- [4] Selection Effects: Distance Band Analysis ---`);
    console.table(val.selectionEffects.distanceBands);

    console.log(`\n--- [5] Paired Conditional Excursions on Matched Price Zones ---`);
    console.log(val.selectionEffects.pairedMatchedZoneExcursions);
  }

  // Intraday SPY 5m validation
  console.log(`\n>>> Running Rigorous Validation on SPY Intraday 5-Minute (${fixtures.intraday.barCount} bars)`);
  const valIntra = runRigorousValidation('SPY_5M', fixtures.intraday.candles, {
    trainRatio: 0.60,
    embargoBars: 10,
    config: { range: '1D' },
  });

  console.log(`\n--- Held-Out Test Performance: SPY 5m Intraday ---`);
  console.table(
    Object.values(valIntra.heldOutTest).map((m) => ({
      Candidate: m.candidate,
      Levels: m.totalCandidateLevels,
      Touches: m.totalTouches,
      'Touch Rate': `${(m.touchRate * 100).toFixed(1)}%`,
      'Bounce Rate': `${(m.confirmedBounceRate * 100).toFixed(1)}%`,
      'MBB-10 95% CI': `[${(m.bounceRateCI95_MBB10[0] * 100).toFixed(1)}%, ${(m.bounceRateCI95_MBB10[1] * 100).toFixed(1)}%]`,
      'Breakout Rate': `${(m.confirmedBreakoutRate * 100).toFixed(1)}%`,
      'False Breakout': `${(m.falseBreakoutRate * 100).toFixed(1)}%`,
      'Rejection Rate': `${(m.rejectionRate * 100).toFixed(1)}%`,
      Coverage: `${(m.opportunityCoverage * 100).toFixed(1)}%`,
      'Zone Churn': `${(m.zoneChurnRate * 100).toFixed(1)}%`,
      'MFE/MAE': m.mfeMaeRatio.toFixed(2),
      N_eff: m.nEff,
    })),
  );

  console.log('\n================================================================================');
  console.log('                         VALIDATION RUN COMPLETE                                ');
  console.log('================================================================================\n');
}

main().catch(console.error);
