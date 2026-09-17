'use strict';
// Samples what the Record page renders while a recording starts and while it is
// finalized and uploaded after stop. Every phase must render a visible view;
// an empty page with only the mode tabs is the reported "white screen".

const { buildScenario } = require('./lib/audio');
const { startMockBackend } = require('./lib/mock-backend');
const { AppDriver, sleep } = require('./lib/app-driver');

const VIEWS = {
  overlay: '.recording-pipeline-overlay',
  starting: '.recording-starting-card',
  idle: '.idle-layout',
  recording: '.recording-card',
  error: '.error-card',
  uploaded: '.upload-success-card',
};

function sampleView(views) {
  const visible = selector => [...document.querySelectorAll(selector)].some(element => element.getClientRects().length > 0);
  const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
  return {
    at: Date.now(),
    phase: pinia?.state?.value?.recording?.phase ?? null,
    shown: Object.keys(views).filter(name => visible(views[name])),
    tabs: visible('.mode-tab-switcher'),
  };
}

function startSampler(app, intervalMs = 100) {
  const samples = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try { samples.push(await app.evalTimed(sampleView, VIEWS, 5000)); }
      catch (error) { samples.push({ at: Date.now(), error: error.message }); }
      await sleep(intervalMs);
    }
  })();
  return { samples, stop: async () => { running = false; await loop; } };
}

// Collapse samples into runs of identical rendering so a report shows each
// state once with its observed duration.
function summarize(samples) {
  const runs = [];
  for (const sample of samples) {
    const key = sample.error ? `error:${sample.error}` : `${sample.phase}|${sample.shown.join('+') || 'NOTHING'}|tabs=${sample.tabs}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key) { last.until = sample.at; last.samples++; }
    else runs.push({ key, from: sample.at, until: sample.at, samples: 1, sample });
  }
  return runs;
}

const PIPELINE_PHASES = ['preparing', 'stopping', 'stopped', 'processing', 'uploading'];

function assessSamples(samples, label) {
  const problems = [];
  const runs = summarize(samples);
  for (const run of runs) {
    const { sample } = run;
    if (sample.error) continue;
    const ms = run.until - run.from;
    if (!sample.shown.length) problems.push(`${label}: empty page in phase '${sample.phase}' for ~${ms} ms (${run.samples} samples, tabs visible: ${sample.tabs})`);
    else if (sample.tabs && PIPELINE_PHASES.includes(sample.phase)) problems.push(`${label}: mode tabs clickable in phase '${sample.phase}' for ~${ms} ms`);
  }
  const notes = runs.map(run => `${label}: ${run.key} for ~${run.until - run.from} ms (${run.samples} samples)`);
  return { problems, notes, runs };
}

async function runFinalizingViewCheck({
  recordSeconds = Number(process.env.SUISSE_FINALIZING_VIEW_SECONDS) || 240,
  cdpPort = 9339,
  mockPort = 3000,
} = {}) {
  const scenario = buildScenario('s17-finalizing-view', [{ type: 'speech', seconds: recordSeconds + 90 }]);
  const mock = await startMockBackend({ port: mockPort });
  const app = new AppDriver({ name: 's17-finalizing-view', apiUrl: mock.url, fakeAudioWav: scenario.wavPath, cdpPort });
  try {
    await app.launch({ freshProfile: true });
    await app.login();

    const start = startSampler(app);
    await app.startRecording();
    await app.waitForPhase(['recording'], 60_000);
    await sleep(1000);
    await start.stop();

    await sleep(recordSeconds * 1000);

    const stop = startSampler(app);
    const stoppedAt = Date.now();
    await app.stopRecording();
    await app.waitForPhase(['uploaded', 'error'], 600_000);
    const settledAt = Date.now();
    await sleep(1500);
    await stop.stop();

    const started = assessSamples(start.samples, 'start');
    const stopped = assessSamples(stop.samples, 'stop');
    const finalPhase = await app.getPhase();
    const problems = [...started.problems, ...stopped.problems];
    if (finalPhase !== 'uploaded') problems.push(`Expected the recording to finish uploaded, final phase '${finalPhase}'`);
    return {
      pass: problems.length === 0,
      problems,
      notes: [`recorded ~${recordSeconds}s; stop to uploaded ${settledAt - stoppedAt} ms`, ...started.notes, ...stopped.notes],
      samples: { start: start.samples, stop: stop.samples },
    };
  } finally {
    await app.close({ keepProfile: true });
    await mock.close();
  }
}

module.exports = { runFinalizingViewCheck, assessSamples, summarize, sampleView, VIEWS };
