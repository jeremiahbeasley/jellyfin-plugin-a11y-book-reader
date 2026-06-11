// Runs every QA suite in sequence against the live server and prints one
// summary. Exit code is non-zero if any check fails (CI-friendly).
const { print } = require('./lib/report');

const SUITES = [
  ['Functional', './tests/functional'],
  ['Accessibility', './tests/accessibility'],
  ['Responsive', './tests/responsive'],
  ['TTS', './tests/tts'],
  ['Multi-book', './tests/multibook'],
  ['Scroll-follow', './tests/scroll-follow'],
  ['Annotations', './tests/annotations'],
];

(async () => {
  let totalFail = 0, totalRun = 0;
  for (const [name, mod] of SUITES) {
    try {
      const results = await require(mod).run();
      totalFail += print(name, results);
      totalRun += results.length;
    } catch (e) {
      console.log('=== ' + name + ' ===');
      console.log('SUITE ERROR: ' + e.message);
      totalFail += 1; totalRun += 1;
    }
    console.log('');
  }
  console.log('==================================================');
  console.log('OVERALL ' + (totalRun - totalFail) + '/' + totalRun + ' checks passed' + (totalFail ? ', ' + totalFail + ' FAILED' : ' — all green'));
  process.exit(totalFail ? 1 : 0);
})();
