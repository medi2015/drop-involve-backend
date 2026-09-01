/**
 * Drop Involve — uptime monitor
 *
 * Runs on Google Apps Script every five minutes, checks the service is
 * answering, and emails when it isn't. Independent of the Vultr box, so it
 * still works when that machine is the thing that's broken.
 *
 * Setup:
 *   1. script.google.com → New project → paste this in
 *   2. Run setUp() once and approve the permissions prompt
 *   3. Run testAlert() to confirm the email arrives
 *
 * Written after two days of unnoticed downtime on 21–22 August 2026, when
 * nginx died on a config error and nothing said so.
 */

const CONFIG = {
  // Everyone here gets every alert. More than one address on purpose: a single
  // inbox nobody reads on a Saturday is how the last outage went unnoticed.
  recipients: [
    'mehdi@involve.no',
  ],

  checks: [
    {
      name: 'API (file.involve.no)',
      url: 'https://file.involve.no/health',
      // Not just a 200: nginx can answer while the app behind it is broken.
      keyword: '"ok":true',
    },
    {
      name: 'Nettsted (drop.involve.no)',
      url: 'https://drop.involve.no',
      keyword: null,
    },
  ],

  // Two consecutive failures before alerting, so a single dropped packet
  // doesn't wake you. At a five-minute interval that's a ~10 minute delay.
  failuresBeforeAlert: 2,
};

/** Called by the trigger. */
function checkAll() {
  const store = PropertiesService.getScriptProperties();

  CONFIG.checks.forEach(function (check) {
    const stateKey = 'state_' + check.url;
    const state = JSON.parse(store.getProperty(stateKey) || '{"failures":0,"alerted":false}');

    const result = probe(check);

    if (result.ok) {
      if (state.alerted) {
        notify(
          '✅ Oppe igjen: ' + check.name,
          check.name + ' svarer normalt igjen.\n\n' +
          'URL: ' + check.url + '\n' +
          'Tid: ' + now()
        );
      }
      store.setProperty(stateKey, JSON.stringify({ failures: 0, alerted: false }));
      return;
    }

    state.failures += 1;

    if (state.failures >= CONFIG.failuresBeforeAlert && !state.alerted) {
      notify(
        '🔴 Nede: ' + check.name,
        check.name + ' svarer ikke.\n\n' +
        'URL: ' + check.url + '\n' +
        'Feil: ' + result.detail + '\n' +
        'Mislykkede forsøk: ' + state.failures + '\n' +
        'Tid: ' + now() + '\n\n' +
        'Sjekk serveren:\n' +
        '  ssh root@80.240.25.105\n' +
        '  pm2 status\n' +
        '  systemctl status nginx\n' +
        '  nginx -t'
      );
      state.alerted = true;
    }

    store.setProperty(stateKey, JSON.stringify(state));
  });
}

/** One HTTP check. Never throws — a thrown error is itself a failure. */
function probe(check) {
  try {
    const response = UrlFetchApp.fetch(check.url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true,
    });

    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code !== 200) {
      // 521 and 522 come from Cloudflare and mean it couldn't reach the origin
      // — the server is down rather than the site being misconfigured.
      const hint = (code === 521 || code === 522)
        ? ' (Cloudflare når ikke serveren)'
        : '';
      return { ok: false, detail: 'HTTP ' + code + hint };
    }

    if (check.keyword && body.indexOf(check.keyword) === -1) {
      return {
        ok: false,
        detail: 'Svarte 200, men manglet «' + check.keyword + '». Første 200 tegn: ' +
                body.substring(0, 200),
      };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
}

function notify(subject, body) {
  CONFIG.recipients.forEach(function (address) {
    MailApp.sendEmail(address, '[Drop Involve] ' + subject, body);
  });
}

function now() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss z');
}

/** Run once. Replaces any existing trigger so re-running is safe. */
function setUp() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'checkAll') ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp.newTrigger('checkAll').timeBased().everyMinutes(5).create();

  // Clear any stale state so the first run starts from a clean slate.
  PropertiesService.getScriptProperties().deleteAllProperties();

  Logger.log('Trigger created: checkAll every 5 minutes');
}

/** Confirms alerts actually arrive, without waiting for an outage. */
function testAlert() {
  notify(
    'Testvarsel',
    'Dette er en test. Overvåkingen fungerer og varsler kommer fram.\n\nTid: ' + now()
  );
  Logger.log('Test sent to: ' + CONFIG.recipients.join(', '));
}

/** Runs every check once and logs the result. Sends nothing. */
function checkNow() {
  CONFIG.checks.forEach(function (check) {
    const result = probe(check);
    Logger.log(check.name + ': ' + (result.ok ? 'OK' : 'FEIL — ' + result.detail));
  });
}
