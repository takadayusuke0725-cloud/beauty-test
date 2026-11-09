// ==UserScript==
// @name         FakeCamPipeV7
// @description  【実験V7】覆いは478点を包む形。カメラ遅れの記録と、枚数(約11枚/秒)の原因切り分けを約5分で測る。覆いは仮の単色。配信開始は押さないこと。
// @match        https://stripchat.com/*
// @match        https://*.stripchat.com/*
// @match        https://takadayusuke0725-cloud.github.io/*
// @run-at       document-start
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';
  if (window.__fakeCamInstalledV7) return;
  window.__fakeCamInstalledV7 = true;

  // ====== 調整値 ======
  var COVER_SCALE = 1.0; // 覆いの倍率（大きくしない）
  var YAW_LIMIT_DEG = 0; // 左右の向きの許容（度）。0＝制限なし（試験用）
  var MIN_FACE_WIDTH = 0; // 顔の幅（画面比）の下限。0＝制限なし（試験用）
  var EDGE_MARGIN = 0.01; // 顔の輪郭が画面の端からこの比率以内なら待機画面
  var COVER_COLOR = '#d8b79c'; // 36点の形の色
  var COVER_COLOR_HULL = '#c04040'; // 478点を包む形の色（はみ出し部分が赤く見える）
  var shapeMode = 1; // 0＝36点の形だけ／1＝478点を包む形だけ（V7の標準）／2＝両方（赤＝包む形のはみ出し）
  var TS = typeof window.__v7TimeScale === 'number' && window.__v7TimeScale > 0 ? window.__v7TimeScale : 1; // 擬似環境の試験用。通常は1

  // ====== 部品の場所（Google公式の案内どおり） ======
  var MP_MODULE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs';
  var MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
  var MP_MODEL =
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

  // 顔の外周の点の番号（MediaPipeの標準。記憶ベースで未確認。目視で確認する）
  var FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
    149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
  ];

  // 主要パーツの点の番号（MediaPipeの標準。記憶ベースで未確認。目視で確認する）
  var PARTS = [
    { name: '目', ids: [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173, 263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398] },
    { name: '眉', ids: [46, 53, 52, 65, 55, 70, 63, 105, 66, 107, 276, 283, 282, 295, 285, 300, 293, 334, 296, 336] },
    { name: '鼻', ids: [1, 2, 4, 5, 6, 19, 94, 98, 327, 168, 195, 197, 129, 358] },
    { name: '口', ids: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 185, 40, 39, 37, 0, 267, 269, 270, 409, 78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 191, 80, 81, 82, 13, 312, 311, 310, 415] },
    { name: '頬', ids: [116, 117, 118, 119, 123, 147, 187, 205, 50, 101, 345, 346, 347, 348, 352, 376, 411, 425, 280, 330] }
  ];
  var KEYIDS = [];
  var KEYPART = [];
  (function () {
    for (var p = 0; p < PARTS.length; p++) {
      for (var q = 0; q < PARTS[p].ids.length; q++) {
        KEYIDS.push(PARTS[p].ids[q]);
        KEYPART.push(p);
      }
    }
  })();

  // ====== 試験の進行（枚数の原因切り分け。約4分、動かず正面で座る） ======
  // drive: rvfc＝カメラの映像が更新されるたびに処理（今の方式）／raf＝画面の更新ごとに、新しい映像があれば処理
  // big: 本物の映像を載せたvideoを、小さく透明(2px)にするか、少し大きく見える状態(180x240)にするか
  // detect: on＝毎コマ検出／half＝2コマに1回だけ検出（間は前の位置を使う）／off＝検出しない（待機画面を出す）
  var PHASES = [
    { name: '現状(基準)', drive: 'rvfc', big: false, detect: 'on', text: '正面で動かず座る' },
    { name: '検出なし(カメラ素の枚数)', drive: 'rvfc', big: false, detect: 'off', text: '正面で動かず座る（待機画面になる）' },
    { name: '画面の更新に合わせて処理(raf)', drive: 'raf', big: false, detect: 'on', text: '正面で動かず座る' },
    { name: '映像を大きく(180x240)', drive: 'rvfc', big: true, detect: 'on', text: '正面で動かず座る（左上に自分の小窓が出る。録画しない）' },
    { name: 'rafと大きい映像の組み合わせ', drive: 'raf', big: true, detect: 'on', text: '正面で動かず座る（左上に自分の小窓が出る。録画しない）' },
    { name: '検出を2コマに1回', drive: 'rvfc', big: false, detect: 'half', text: '正面で動かず座る' },
    { name: '現状に戻す(再確認)', drive: 'rvfc', big: false, detect: 'on', text: '正面で動かず座る' }
  ];
  var PHASE_SEC = 30;
  var HIDDEN_CSS = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
  var BIG_CSS = 'position:fixed;left:0;top:0;width:180px;height:240px;opacity:0.3;pointer-events:none;z-index:2147483000;';

  var t0 = Date.now();
  var logs = [];
  var MAX = 600;
  var isOpen = false;
  var calls = 0;
  var panel = null;
  var head = null;
  var body = null;
  var seen = {};
  var promptText = '';
  var promptEnd = 0;

  // ---- 測定の数字 ----
  var C = { out: 0, det: 0, P1: 0, P2: 0, P3: 0, raf: 0, pres: 0, skip: 0 };
  var S = { out: 0, det: 0, P1: 0, P2: 0, P3: 0, raf: 0, pres: 0, skip: 0, detAvg: 0, procAvg: 0, standbyPct: 0, lagCam: -1, metAvg: 0 };
  var detSamples = [];
  var procSamples = [];
  var metSamples = [];
  var runDetMax = 0;
  var runProcMax = 0;
  var lostCount = 0;
  var wasFace = false;
  var winFace = 0;
  var winStandby = 0;
  var reasonCount = {};
  var lastTs = 0;
  var detErrCount = 0;
  var metErrCount = 0;
  var detectMode = 'on';
  var lagSum = 0;
  var lagN = 0;
  var lagMax = 0;

  // ---- 向き（度）----
  var yawM = null; // 行列から（左右）
  var pitchM = null; // 行列から（上下）
  var yawG = null; // 顔の点の奥行きから（左右。行列の符号の確認用）
  var pitchG = null;
  var layoutLogged = false;
  var agreeYaw = [0, 0]; // [一致, 不一致]（|向き|>15度のとき）
  var agreePitch = [0, 0];
  var lastAng = null;
  var lostInfo = null;
  var stopsN = 0;

  // ---- 角度別の記録 ----
  var BIN_EDGES = [15, 30, 45, 60, 75];
  var BIN_LABEL = ['0-15°', '15-30°', '30-45°', '45-60°', '60-75°', '75°以上'];
  function newBin() {
    return {
      n: 0, pin: [0, 0, 0, 0, 0], ptot: [0, 0, 0, 0, 0], minPct: 100, tipOut: 0,
      ratioSum: 0, ratioN: 0, ovChgSum: 0, ovChgMax: 0, huChgSum: 0, huChgMax: 0, chgN: 0,
      jRaw: 0, jRel: 0, jRelMax: 0, jN: 0
    };
  }
  var bins = [];
  (function () {
    for (var i = 0; i < 6; i++) bins.push(newBin());
  })();
  var prevKey = null;
  var prevAOv = 0;
  var prevAHu = 0;

  // ---- 区間・局面の集計 ----
  function newAcc() {
    return { frames: 0, standby: 0, secs: 0, out: 0, proc: 0, det: 0, P1: 0, P2: 0, P3: 0, raf: 0, pres: 0, skip: 0, lagSum: 0, lagN: 0, lagMax: 0, srcStart: -1, lost: 0, mP: 0, mN: 0, gP: 0, gN: 0, pP: 0, pN: 0 };
  }
  var totAcc = newAcc();
  var curPhase = null;
  var curPhaseIdx = -1;

  // ---- 顔認識の部品 ----
  var landmarker = null;
  var mpFailed = false;
  var mpPromise = null;

  // ---- 動作中の処理（パイプライン） ----
  var curPipe = null;
  var curPipeP = null;
  var curKey = null;

  // ====== 記録と表示 ======
  function ts() {
    return ((Date.now() - t0) / 1000).toFixed(1) + 's ';
  }
  function short(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function safeJson(o) {
    try {
      return JSON.stringify(o);
    } catch (e) {
      return '(JSON化できず)';
    }
  }
  function r0(n) {
    return Math.round(n);
  }
  function r1(n) {
    return Math.round(n * 10) / 10;
  }
  function r2(n) {
    return Math.round(n * 100) / 100;
  }
  function fa(v) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    return (v >= 0 ? '+' : '') + r0(v);
  }
  function errText(e) {
    if (!e) return '不明';
    return (e.name || '') + ' ' + (e.message || e);
  }
  function describe(s) {
    try {
      return '映像' + s.getVideoTracks().length + '本／音声' + s.getAudioTracks().length + '本／active=' + s.active;
    } catch (e) {
      return '(MediaStreamではない)';
    }
  }
  function angUse() {
    if (yawM !== null) return yawM;
    if (yawG !== null) return yawG;
    return 0;
  }
  var SHAPE_NAME = ['36点だけ', '478包みだけ', '両方(赤=包みのはみ出し)'];
  function updateHead() {
    if (!head) return;
    var pr = '';
    if (promptText) {
      var left = promptEnd ? Math.max(0, Math.round((promptEnd - performance.now()) / 1000)) : 0;
      pr = promptText + (promptEnd ? ' 残' + left + '秒' : '') + '\n';
    }
    head.textContent =
      pr +
      'V7（要求' + calls + '回）' + (isOpen ? ' ▼' : ' ▲タップで開く') + '\n' +
      '出力' + S.out + 'fps／到着' + S.pres + 'fps／検出' + S.det + 'fps／検出' + r1(S.detAvg) + 'ms(最大' + r0(runDetMax) + ')／処理' +
      r1(S.procAvg) + 'ms(最大' + r0(runProcMax) + ')／測定' + r1(S.metAvg) + 'ms\n' +
      '見失い' + lostCount + '回／待機' + S.standbyPct + '%' + (S.lagCam >= 0 ? '／カメラ遅れ' + r0(S.lagCam) + 'ms' : '') + '\n' +
      '向き 左右' + fa(yawM) + '°(行列)/' + fa(yawG) + '°(幾何) 上下' + fa(pitchM) + '°(行列)/' + fa(pitchG) + '°(幾何)';
  }
  function render() {
    if (!panel) return;
    updateHead();
    body.style.display = isOpen ? 'block' : 'none';
    if (isOpen) {
      body.textContent = logs.join('\n');
      body.scrollTop = body.scrollHeight;
    }
  }
  function log(msg) {
    logs.push(ts() + short(msg, 260));
    if (logs.length > MAX) logs.shift();
    render();
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        ta.setSelectionRange(0, text.length);
      } catch (e) {}
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      log(ok ? 'ログをコピーした（代替方式）' : 'コピー失敗：ログ表示を開いて長押しで選ぶ');
    } catch (e) {
      log('コピー失敗 ' + errText(e));
    }
  }
  function copyLogs() {
    var text = logs.join('\n');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            log('ログをコピーした（' + logs.length + '行）');
          },
          function () {
            fallbackCopy(text);
          }
        );
        return;
      }
    } catch (e) {}
    fallbackCopy(text);
  }
  function makeBtn(label, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'margin:2px 4px 2px 0;padding:3px 8px;font:11px sans-serif;color:#0f0;background:#143314;' +
      'border:1px solid #0f0;border-radius:4px;';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      try {
        fn(b);
      } catch (err) {
        log('ボタンの例外 ' + errText(err));
      }
    });
    return b;
  }
  function ensurePanel() {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.style.cssText =
        'position:fixed;left:4px;bottom:4px;z-index:2147483647;max-width:96vw;' +
        'background:rgba(0,0,0,.88);color:#0f0;font:11px/1.35 sans-serif;' +
        'padding:4px 8px;border-radius:6px;';
      head = document.createElement('div');
      head.style.cssText = 'font-weight:bold;padding:2px 0;white-space:pre-wrap;';
      head.addEventListener('click', function () {
        isOpen = !isOpen;
        render();
      });
      var row = document.createElement('div');
      row.appendChild(
        makeBtn('形:' + SHAPE_NAME[shapeMode], function (b) {
          shapeMode = (shapeMode + 1) % 3;
          b.textContent = '形:' + SHAPE_NAME[shapeMode];
          log('覆いの形を切り替え：' + SHAPE_NAME[shapeMode]);
        })
      );
      row.appendChild(
        makeBtn('集計を出す', function () {
          logBins('手動');
        })
      );
      row.appendChild(
        makeBtn('ログをコピー', function () {
          copyLogs();
        })
      );
      body = document.createElement('pre');
      body.style.cssText =
        'display:none;margin:4px 0;max-height:42vh;max-width:92vw;overflow:auto;' +
        'white-space:pre-wrap;word-break:break-all;font:10px/1.3 monospace;color:#0f0;';
      panel.appendChild(head);
      panel.appendChild(row);
      panel.appendChild(body);
    }
    if (!panel.isConnected) document.body.appendChild(panel);
    render();
  }
  setInterval(ensurePanel, 500);
  document.addEventListener('DOMContentLoaded', ensurePanel);

  log('V7起動 ' + location.hostname + '／' + (window.top !== window ? 'iframe内' : '最上位'));

  // ====== エラーとページの制限の記録 ======
  window.addEventListener('error', function (e) {
    log('エラー: ' + (e && e.message));
  });
  window.addEventListener('unhandledrejection', function (e) {
    log('未処理の拒否: ' + errText(e && e.reason));
  });
  document.addEventListener('securitypolicyviolation', function (e) {
    log('制限に引っかかった: ' + e.violatedDirective + ' ' + short(e.blockedURI, 90));
  });
  ['error', 'warn'].forEach(function (k) {
    var orig = console[k];
    console[k] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length && i < 3; i++) {
          var a = arguments[i];
          parts.push(a && a.message ? a.message : typeof a === 'object' ? '[object]' : String(a));
        }
        var m = parts.join(' ');
        if (/camera|media|permission|denied|NotAllowed|stream|device/i.test(m)) {
          log('console.' + k + ': ' + m);
        }
      } catch (e) {}
      return orig.apply(console, arguments);
    };
  });

  // ====== A：ページで使える機能と制限の点検 ======
  function envCheck() {
    try {
      log('WebAssembly: ' + (typeof WebAssembly !== 'undefined' ? 'あり' : 'なし'));
    } catch (e) {}
    try {
      var cv = document.createElement('canvas');
      log('WebGL2: ' + (cv.getContext('webgl2') ? 'あり' : 'なし') + '／OffscreenCanvas: ' + (typeof OffscreenCanvas !== 'undefined' ? 'あり' : 'なし'));
    } catch (e) {
      log('WebGL2の確認で例外 ' + errText(e));
    }
    try {
      log(
        'requestVideoFrameCallback: ' +
          (typeof HTMLVideoElement !== 'undefined' && HTMLVideoElement.prototype.requestVideoFrameCallback ? 'あり' : 'なし')
      );
    } catch (e) {}
    try {
      var u = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
      var w = new Worker(u);
      w.onmessage = function () {
        log('Worker(blob): 動いた');
        w.terminate();
      };
      w.onerror = function () {
        log('Worker(blob): 失敗');
      };
    } catch (e) {
      log('Worker(blob): 作れない ' + errText(e));
    }
    try {
      fetch(location.href, { credentials: 'same-origin' }).then(
        function (r) {
          var csp = r.headers.get('content-security-policy') || r.headers.get('content-security-policy-report-only');
          if (!csp) {
            log('CSP(ヘッダー): なし');
            return;
          }
          csp.split(';').forEach(function (d) {
            d = d.trim();
            if (/^(default-src|script-src|connect-src|worker-src|media-src)/.test(d)) log('CSP ' + short(d, 150));
          });
        },
        function (e) {
          log('CSPの確認に失敗 ' + errText(e));
        }
      );
    } catch (e) {}
    [['部品(JS)', MP_MODULE], ['モデル', MP_MODEL]].forEach(function (p) {
      try {
        fetch(p[1], { method: 'HEAD' }).then(
          function (r) {
            log('取得テスト ' + p[0] + ': ' + r.status + ' 大きさ' + (r.headers.get('content-length') || '不明'));
          },
          function (e) {
            log('取得テスト ' + p[0] + ': 失敗 ' + errText(e));
          }
        );
      } catch (e) {
        log('取得テスト ' + p[0] + ': 例外 ' + errText(e));
      }
    });
  }
  envCheck();

  // ====== 顔認識の部品の読み込み ======
  function tryCreate(mod, fileset, delegate) {
    return mod.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MP_MODEL, delegate: delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true // 向き（度）を出すため
    }).then(function (lm) {
      log('顔認識を作成 delegate=' + delegate);
      return lm;
    });
  }
  function loadMediaPipe() {
    if (mpPromise) return mpPromise;
    var tl = performance.now();
    var modP = window.__mpTestStub ? Promise.resolve(window.__mpTestStub) : import(MP_MODULE);
    mpPromise = modP
      .then(function (mod) {
        log('部品(JS)の読み込み成功 ' + r0(performance.now() - tl) + 'ms');
        return mod.FilesetResolver.forVisionTasks(MP_WASM).then(function (fileset) {
          log('wasmの準備OK ' + r0(performance.now() - tl) + 'ms');
          return tryCreate(mod, fileset, 'GPU').catch(function (e) {
            log('GPUで失敗(' + short(errText(e), 60) + ')→CPUで再試行');
            return tryCreate(mod, fileset, 'CPU');
          });
        });
      })
      .then(
        function (lm) {
          landmarker = lm;
          log('顔認識の準備完了 ' + r0(performance.now() - tl) + 'ms');
          return lm;
        },
        function (e) {
          mpFailed = true;
          log('顔認識の準備に失敗: ' + short(errText(e), 120));
          throw e;
        }
      );
    mpPromise.catch(function () {});
    return mpPromise;
  }

  // ====== 画面に出す部品 ======
  function makeHiddenVideo() {
    var el = document.createElement('video');
    el.__v5 = true;
    el.muted = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }
  function removeEl(pipe, el) {
    try {
      if (el.parentNode) el.parentNode.removeChild(el);
    } catch (e) {}
    var i = pipe.els.indexOf(el);
    if (i >= 0) pipe.els.splice(i, 1);
  }
  function playQuiet(el, tag) {
    try {
      var pr = el.play();
      if (pr && pr.catch) {
        pr.catch(function (e) {
          log(tag + ' のplay失敗 ' + (e && e.name));
        });
      }
    } catch (e) {}
  }
  function countFrames(el, key, pipe) {
    if (!el.requestVideoFrameCallback) {
      log('requestVideoFrameCallbackなし(' + key + ')');
      return;
    }
    function cb() {
      if (pipe.stopped || el.__off) return;
      C[key]++;
      el.requestVideoFrameCallback(cb);
    }
    el.requestVideoFrameCallback(cb);
  }
  function waitForSize(v, ms) {
    return new Promise(function (resolve) {
      var waited = 0;
      var id = setInterval(function () {
        waited += 50;
        if (v.videoWidth > 0 || waited >= ms) {
          clearInterval(id);
          resolve();
        }
      }, 50);
    });
  }

  // ====== 計算（形・向き） ======
  function hull(P) {
    var a = P.slice().sort(function (p, q) {
      return p[0] - q[0] || p[1] - q[1];
    });
    var n = a.length;
    if (n < 3) return a;
    function cross(o, p, q) {
      return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    }
    var lo = [];
    var up = [];
    var i;
    for (i = 0; i < n; i++) {
      while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], a[i]) <= 0) lo.pop();
      lo.push(a[i]);
    }
    for (i = n - 1; i >= 0; i--) {
      while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], a[i]) <= 0) up.pop();
      up.push(a[i]);
    }
    lo.pop();
    up.pop();
    return lo.concat(up);
  }
  function polyArea(P) {
    var s = 0;
    var n = P.length;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      s += P[i][0] * P[j][1] - P[j][0] * P[i][1];
    }
    return Math.abs(s) / 2;
  }
  function inPoly(x, y, P) {
    var c = false;
    for (var i = 0, j = P.length - 1; i < P.length; j = i++) {
      var xi = P[i][0];
      var yi = P[i][1];
      var xj = P[j][0];
      var yj = P[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function scalePoly(P, cx, cy, k) {
    if (k === 1) return P;
    var out = [];
    for (var i = 0; i < P.length; i++) out.push([cx + (P[i][0] - cx) * k, cy + (P[i][1] - cy) * k]);
    return out;
  }
  function buildGeom(pts, w, h) {
    var i;
    var all = [];
    for (i = 0; i < pts.length; i++) all.push([pts[i].x * w, pts[i].y * h]);
    var ov = [];
    var cx = 0;
    var cy = 0;
    for (i = 0; i < FACE_OVAL.length; i++) {
      var q = all[FACE_OVAL[i]];
      ov.push(q);
      cx += q[0];
      cy += q[1];
    }
    cx /= FACE_OVAL.length;
    cy /= FACE_OVAL.length;
    var hu = hull(all);
    return {
      all: all,
      ov: scalePoly(ov, cx, cy, COVER_SCALE),
      hu: scalePoly(hu, cx, cy, COVER_SCALE)
    };
  }
  // 顔の変換行列から向き（度）を出す。符号の向きは未確認（試験の区間で左右・上下を向いて確認する）
  function matInfo(res) {
    try {
      var ms = res && res.facialTransformationMatrixes;
      if (!ms || !ms.length) return null;
      var m = ms[0];
      var d = m && (m.data || m);
      if (!d || d.length < 16) return null;
      var colMajor =
        Math.abs(d[12]) + Math.abs(d[13]) + Math.abs(d[14]) >= Math.abs(d[3]) + Math.abs(d[7]) + Math.abs(d[11]);
      var R = function (r, c) {
        return colMajor ? d[c * 4 + r] : d[r * 4 + c];
      };
      var s = Math.sqrt(R(0, 0) * R(0, 0) + R(1, 0) * R(1, 0) + R(2, 0) * R(2, 0)) || 1;
      var yaw = (Math.atan2(R(0, 2), R(2, 2)) * 180) / Math.PI;
      var sp = -R(1, 2) / s;
      if (sp > 1) sp = 1;
      if (sp < -1) sp = -1;
      var pitch = (Math.asin(sp) * 180) / Math.PI;
      return { yaw: yaw, pitch: pitch, colMajor: colMajor };
    } catch (e) {
      return null;
    }
  }
  // 顔の点の奥行き(z)から向きを出す（行列の確認用の別方式）
  function geoAngles(pts, aspect) {
    var a = pts[454];
    var b = pts[234];
    var t = pts[10];
    var c = pts[152];
    if (!a || !b || !t || !c) return [null, null];
    if (typeof a.z !== 'number' || typeof b.z !== 'number' || typeof t.z !== 'number' || typeof c.z !== 'number') return [null, null];
    var yaw = (Math.atan2(a.z - b.z, a.x - b.x) * 180) / Math.PI;
    var pitch = (Math.atan2(c.z - t.z, (c.y - t.y) * aspect) * 180) / Math.PI;
    return [yaw, pitch];
  }
  function updatePose(res, pts, w, h) {
    var m = matInfo(res);
    if (m) {
      yawM = m.yaw;
      pitchM = m.pitch;
      if (!layoutLogged) {
        layoutLogged = true;
        log('向きの行列：' + (m.colMajor ? '列ごとの並び' : '行ごとの並び') + 'と判定');
      }
    } else {
      yawM = null;
      pitchM = null;
    }
    var g = geoAngles(pts, h / w);
    yawG = g[0];
    pitchG = g[1];
    if (yawM !== null && yawG !== null && Math.abs(yawM) > 15) {
      if (yawM * yawG > 0) agreeYaw[0]++;
      else agreeYaw[1]++;
    }
    if (pitchM !== null && pitchG !== null && Math.abs(pitchM) > 10) {
      if (pitchM * pitchG > 0) agreePitch[0]++;
      else agreePitch[1]++;
    }
  }
  function upMax(a) {
    if (yawM !== null) {
      if (yawM > a.mP) a.mP = yawM;
      if (-yawM > a.mN) a.mN = -yawM;
    }
    if (yawG !== null) {
      if (yawG > a.gP) a.gP = yawG;
      if (-yawG > a.gN) a.gN = -yawG;
    }
    if (pitchM !== null) {
      if (pitchM > a.pP) a.pP = pitchM;
      if (-pitchM > a.pN) a.pN = -pitchM;
    }
  }
  function binOf(a) {
    for (var i = 0; i < BIN_EDGES.length; i++) if (a < BIN_EDGES[i]) return i;
    return BIN_EDGES.length;
  }

  // 顔の位置が危ないとき、理由を返す（問題なければnull）。標準は「画面の端」だけ
  function checkPose(pts) {
    var i;
    for (i = 0; i < FACE_OVAL.length; i++) {
      var p = pts[FACE_OVAL[i]];
      if (p.x < EDGE_MARGIN || p.x > 1 - EDGE_MARGIN || p.y < EDGE_MARGIN || p.y > 1 - EDGE_MARGIN) return '画面の端';
    }
    if (MIN_FACE_WIDTH > 0) {
      var width = pts[454].x - pts[234].x;
      if (Math.abs(width) < MIN_FACE_WIDTH) return '顔が小さい/横向き';
    }
    if (YAW_LIMIT_DEG > 0 && Math.abs(angUse()) > YAW_LIMIT_DEG) return '向きが大きい';
    return null;
  }

  // ====== 描く（待機画面／覆い） ======
  function drawStandby(ctx, w, h, reason) {
    ctx.fillStyle = '#222222';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#dddddd';
    ctx.font = 'bold ' + Math.round(Math.min(w, h) * 0.06) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('待機中', w / 2, h * 0.47);
    ctx.font = Math.round(Math.min(w, h) * 0.04) + 'px sans-serif';
    ctx.fillText('（' + reason + '）', w / 2, h * 0.55);
  }
  function fillPoly(ctx, P, color) {
    ctx.beginPath();
    for (var i = 0; i < P.length; i++) {
      if (i === 0) ctx.moveTo(P[i][0], P[i][1]);
      else ctx.lineTo(P[i][0], P[i][1]);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
  function drawCover(ctx, pts, w, h, g) {
    if (shapeMode === 0) {
      fillPoly(ctx, g.ov, COVER_COLOR);
    } else if (shapeMode === 1) {
      fillPoly(ctx, g.hu, COVER_COLOR);
    } else {
      fillPoly(ctx, g.hu, COVER_COLOR_HULL);
      fillPoly(ctx, g.ov, COVER_COLOR);
    }
    // 追従がわかるよう、仮の目と口を描く
    var fw = Math.abs(pts[454].x - pts[234].x) * w;
    var eyeL = pts.length >= 478 ? pts[468] : pts[33];
    var eyeR = pts.length >= 478 ? pts[473] : pts[263];
    ctx.fillStyle = '#222222';
    ctx.beginPath();
    ctx.arc(eyeL.x * w, eyeL.y * h, fw * 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(eyeR.x * w, eyeR.y * h, fw * 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = Math.max(2, fw * 0.015);
    ctx.beginPath();
    ctx.moveTo(pts[61].x * w, pts[61].y * h);
    ctx.lineTo(pts[291].x * w, pts[291].y * h);
    ctx.stroke();
  }

  // ====== 角度別の測定（主要パーツの被覆・覆いの安定・点のぶれ） ======
  function recordMetrics(g) {
    var ang = Math.abs(angUse());
    var B = bins[binOf(ang)];
    B.n++;
    var k;
    var allIn = 0;
    var cur = [];
    for (k = 0; k < KEYIDS.length; k++) {
      var q = g.all[KEYIDS[k]];
      cur.push(q);
      var pi = KEYPART[k];
      B.ptot[pi]++;
      if (inPoly(q[0], q[1], g.ov)) {
        B.pin[pi]++;
        allIn++;
      } else if (KEYIDS[k] === 1) {
        B.tipOut++;
      }
    }
    var pct = (100 * allIn) / KEYIDS.length;
    if (pct < B.minPct) B.minPct = pct;
    var aOv = polyArea(g.ov);
    var aHu = polyArea(g.hu);
    if (aOv > 0) {
      B.ratioSum += aHu / aOv;
      B.ratioN++;
    }
    if (prevKey && prevAOv > 0 && prevAHu > 0) {
      var c1 = (100 * Math.abs(aOv - prevAOv)) / prevAOv;
      var c2 = (100 * Math.abs(aHu - prevAHu)) / prevAHu;
      B.ovChgSum += c1;
      B.huChgSum += c2;
      if (c1 > B.ovChgMax) B.ovChgMax = c1;
      if (c2 > B.huChgMax) B.huChgMax = c2;
      B.chgN++;
      var n = cur.length;
      var sx = 0;
      var sy = 0;
      var i;
      for (i = 0; i < n; i++) {
        sx += cur[i][0] - prevKey[i][0];
        sy += cur[i][1] - prevKey[i][1];
      }
      var mx = sx / n;
      var my = sy / n;
      var raw = 0;
      var rel = 0;
      for (i = 0; i < n; i++) {
        var dx = cur[i][0] - prevKey[i][0];
        var dy = cur[i][1] - prevKey[i][1];
        raw += Math.sqrt(dx * dx + dy * dy);
        var rx = dx - mx;
        var ry = dy - my;
        rel += Math.sqrt(rx * rx + ry * ry);
      }
      B.jRaw += raw / n;
      B.jRel += rel / n;
      if (rel / n > B.jRelMax) B.jRelMax = rel / n;
      B.jN++;
    }
    prevKey = cur;
    prevAOv = aOv;
    prevAHu = aHu;
  }
  function logBins(tag) {
    log('━ 角度別の集計（' + tag + '）。角度＝左右の向きの絶対値(行列。なければ幾何) ━');
    for (var i = 0; i < bins.length; i++) {
      var B = bins[i];
      if (!B.n) {
        log(BIN_LABEL[i] + ': 0コマ');
        continue;
      }
      var parts = [];
      for (var p = 0; p < PARTS.length; p++) {
        parts.push(PARTS[p].name + (B.ptot[p] ? r0((100 * B.pin[p]) / B.ptot[p]) : '-'));
      }
      log(
        BIN_LABEL[i] + ' ' + B.n + 'コマ｜36点の形に入った率(%) ' + parts.join(' ') + '｜全体の最小' + r0(B.minPct) +
          '%｜鼻先が外' + B.tipOut + 'コマ'
      );
      log(
        '　形の大きさ(478包み÷36点) ' + (B.ratioN ? r2(B.ratioSum / B.ratioN) : '-') +
          '｜1コマの面積変化 36点 平均' + (B.chgN ? r1(B.ovChgSum / B.chgN) : '-') + '%/最大' + r0(B.ovChgMax) +
          '、478包み 平均' + (B.chgN ? r1(B.huChgSum / B.chgN) : '-') + '%/最大' + r0(B.huChgMax) +
          '｜点のぶれ 全体' + (B.jN ? r1(B.jRaw / B.jN) : '-') + 'px、動きを除いた相対' + (B.jN ? r1(B.jRel / B.jN) : '-') +
          'px(最大' + r1(B.jRelMax) + ')'
      );
    }
    log(
      '符号の一致（行列と幾何）左右 一致' + agreeYaw[0] + '/不一致' + agreeYaw[1] + '、上下 一致' + agreePitch[0] +
        '/不一致' + agreePitch[1] + '｜全体の最大向き(行列) 左右+' + r0(totAcc.mP) + '/-' + r0(totAcc.mN) +
        ' 上下+' + r0(totAcc.pP) + '/-' + r0(totAcc.pN) + '｜(幾何) 左右+' + r0(totAcc.gP) + '/-' + r0(totAcc.gN) +
        '｜止まった回数' + stopsN
    );
  }

  // ====== 1コマの処理 ======
  function noteLag(lag) {
    S.lagCam = lag;
    lagSum += lag;
    lagN++;
    if (lag > lagMax) lagMax = lag;
    if (curPhase) {
      curPhase.lagSum += lag;
      curPhase.lagN++;
      if (lag > curPhase.lagMax) curPhase.lagMax = lag;
    }
  }
  function noteFrameEnd(tStart, meta) {
    C.out++;
    var proc = performance.now() - tStart;
    procSamples.push(proc);
    if (proc > runProcMax) runProcMax = proc;
    if (meta && typeof meta.captureTime === 'number') noteLag(Math.max(0, performance.now() - meta.captureTime));
  }
  function processFrame(pipe, now, meta) {
    var tStart = performance.now();
    var ctx = pipe.ctx;
    var w = pipe.w;
    var h = pipe.h;
    // 映像がいくつ届いたか／いくつ取りこぼしたか（rvfcの情報）
    if (meta && typeof meta.presentedFrames === 'number') {
      if (pipe.lastPres >= 0) {
        var dp = meta.presentedFrames - pipe.lastPres;
        if (dp > 0) C.pres += dp;
        if (dp > 1) C.skip += dp - 1;
      }
      pipe.lastPres = meta.presentedFrames;
    }
    // 試験用：検出しない。本物の映像を描いた上に待機画面を重ねる（本物の顔は出さない）
    if (detectMode === 'off') {
      ctx.drawImage(pipe.video, 0, 0, w, h);
      drawStandby(ctx, w, h, '試験:検出なし');
      wasFace = false;
      prevKey = null;
      prevAOv = 0;
      prevAHu = 0;
      lostInfo = null;
      noteFrameEnd(tStart, meta);
      return;
    }

    var reason = null;
    var pts = null;
    var res = null;
    var g = null;
    var reuse = false;

    if (!landmarker) {
      reason = mpFailed ? '顔認識の部品なし' : '読み込み中';
    } else {
      pipe.frameNo = (pipe.frameNo || 0) + 1;
      if (detectMode === 'half' && pipe.frameNo % 2 === 0 && pipe.lastPts) {
        // 試験用：検出を飛ばして、前の位置をそのまま使う
        pts = pipe.lastPts;
        reuse = true;
      } else {
        var tDet = performance.now();
        var stamp = Math.max(lastTs + 1, Math.round(now));
        lastTs = stamp;
        try {
          res = landmarker.detectForVideo(pipe.video, stamp);
        } catch (e) {
          reason = '検出エラー';
          detErrCount++;
          if (detErrCount <= 3) log('検出で例外 ' + short(errText(e), 100));
        }
        var dms = performance.now() - tDet;
        detSamples.push(dms);
        if (dms > runDetMax) runDetMax = dms;
        C.det++;
        if (!reason) {
          if (res && res.faceLandmarks && res.faceLandmarks.length > 0) pts = res.faceLandmarks[0];
          else reason = '顔を見失い';
        }
        pipe.lastPts = pts;
        if (pts) {
          updatePose(res, pts, w, h);
          reason = checkPose(pts);
        }
      }
    }

    if (!reason) {
      try {
        g = buildGeom(pts, w, h);
      } catch (e) {
        reason = '形の計算エラー';
        log('形の計算で例外 ' + short(errText(e), 100));
      }
    }

    if (reason) {
      drawStandby(ctx, w, h, reason);
      reasonCount[reason] = (reasonCount[reason] || 0) + 1;
      winStandby++;
      totAcc.standby++;
      if (wasFace && reason !== '読み込み中') {
        lostCount++;
        if (reason === '顔を見失い') stopsN++;
        lostInfo = { t: performance.now(), reason: reason, ang: lastAng };
      }
      wasFace = false;
      prevKey = null;
      prevAOv = 0;
      prevAHu = 0;
    } else {
      ctx.drawImage(pipe.video, 0, 0, w, h);
      drawCover(ctx, pts, w, h, g);
      winFace++;
      totAcc.frames++;
      if (lostInfo) {
        var a = lostInfo.ang;
        var dur = (performance.now() - lostInfo.t) / 1000;
        log(
          '停止(' + lostInfo.reason + ')→復帰 待機' + r2(dur) + '秒｜直前の向き(行列) 左右' + (a ? fa(a.yawM) : '-') +
            '° 上下' + (a ? fa(a.pitchM) : '-') + '°｜(幾何) 左右' + (a ? fa(a.yawG) : '-') + '° 上下' + (a ? fa(a.pitchG) : '-') + '°'
        );
        lostInfo = null;
      }
      wasFace = true;
      if (!reuse) {
        lastAng = { yawM: yawM, pitchM: pitchM, yawG: yawG, pitchG: pitchG };
        upMax(totAcc);
      }
    }
    noteFrameEnd(tStart, meta);

    // 測定（出力を描いた後に行う）
    if (g && !reuse) {
      var tm = performance.now();
      try {
        recordMetrics(g);
      } catch (e) {
        metErrCount++;
        if (metErrCount <= 3) log('測定で例外 ' + short(errText(e), 100));
      }
      metSamples.push(performance.now() - tm);
    }
  }

  function playTotal(v) {
    try {
      var q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
      return q ? q.totalVideoFrames : -1;
    } catch (e) {
      return -1;
    }
  }
  // 処理の駆動方式：rvfc＝映像が更新されるたび／raf＝画面の更新ごと（新しい映像があれば処理）
  function startLoop(pipe, mode) {
    var v = pipe.video;
    pipe.gen = (pipe.gen || 0) + 1;
    var gen = pipe.gen;
    pipe.drive = mode;
    pipe.lastPres = -1;
    var lastQ = -1;
    var lastChange = performance.now();
    function alive() {
      return !pipe.stopped && pipe.gen === gen;
    }
    function onRvfc(now, meta) {
      if (!alive()) return;
      try {
        processFrame(pipe, now, meta);
      } catch (e) {
        log('処理中の例外 ' + short(errText(e), 100));
      }
      scheduleR();
    }
    function scheduleR() {
      if (!alive()) return;
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onRvfc);
      else requestAnimationFrame(function (n) {
        onRvfc(n, null);
      });
    }
    function onRaf(now) {
      if (!alive()) return;
      var q = playTotal(v);
      var nowMs = performance.now();
      var isNew;
      if (q !== lastQ) {
        lastChange = nowMs;
        isNew = true;
      } else {
        // デコード数が1秒以上動かない／取れない時は、画面の更新ごとに処理する（試験が止まらないように）
        isNew = q <= 0 || nowMs - lastChange > 1000;
        if (isNew && !pipe.rafWarned) {
          pipe.rafWarned = true;
          log('デコード数が更新されない／取れないため、画面の更新ごとに処理する');
        }
      }
      lastQ = q;
      if (isNew) {
        try {
          processFrame(pipe, now, null);
        } catch (e) {
          log('処理中の例外 ' + short(errText(e), 100));
        }
      }
      requestAnimationFrame(onRaf);
    }
    if (mode === 'raf') requestAnimationFrame(onRaf);
    else scheduleR();
    log('処理の駆動：' + (mode === 'raf' ? '画面の更新(raf)' : '映像の更新(rvfc)'));
  }
  function setBig(pipe, big) {
    try {
      pipe.video.style.cssText = big ? BIG_CSS : HIDDEN_CSS;
    } catch (e) {}
  }

  // ====== 別の小窓（同じカメラ映像を、別のvideoで受けて枚数を比べる）と、画面の更新回数 ======
  function addProbe(pipe, key, css, label) {
    var el = document.createElement('video');
    el.__v5 = true;
    el.muted = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.style.cssText = css;
    (document.body || document.documentElement).appendChild(el);
    pipe.els.push(el);
    el.srcObject = pipe.realStream;
    playQuiet(el, label);
    countFrames(el, key, pipe);
  }
  function startRafCounter(pipe) {
    function f() {
      if (pipe.stopped) return;
      C.raf++;
      requestAnimationFrame(f);
    }
    requestAnimationFrame(f);
  }

  // ====== 試験の進行（局面ごとに設定を切り替え、各30秒） ======
  function applyPhase(pipe, k) {
    var p = PHASES[k];
    detectMode = p.detect;
    setBig(pipe, p.big);
    pipe.frameNo = 0;
    pipe.lastPts = null;
    if (pipe.drive !== p.drive) startLoop(pipe, p.drive);
    else pipe.lastPres = -1;
  }
  function endPhase(pipe) {
    var p = curPhase;
    if (!p) return;
    var s = p.secs || 1;
    var src = pipe && pipe.video && p.srcStart >= 0 ? playTotal(pipe.video) : -1;
    var srcRate = src >= 0 && p.srcStart >= 0 ? r1((src - p.srcStart) / s) : '-';
    log(
      '【試験' + (curPhaseIdx + 1) + ' ' + PHASES[curPhaseIdx].name + '】' + p.secs + '秒 出力' + r1(p.out / s) + '枚/秒 検出' +
        r1(p.det / s) + 'ms 処理' + r1(p.proc / s) + 'ms｜映像の到着' + r1(p.pres / s) + '枚/秒 取りこぼし' + r1(p.skip / s) +
        '枚/秒 デコード数' + srcRate + '枚/秒｜別の小窓 隠し' + r1(p.P1 / s) + ' 大' + r1(p.P2 / s) + ' 非表示' + r1(p.P3 / s) +
        ' 画面更新' + r1(p.raf / s) + '｜カメラ遅れ 平均' + (p.lagN ? r0(p.lagSum / p.lagN) : '-') + 'ms 最大' + (p.lagN ? r0(p.lagMax) : '-') + 'ms'
    );
    curPhase = null;
  }
  function runPhase(pipe, k) {
    if (pipe.stopped) return;
    endPhase(pipe);
    if (k >= PHASES.length) {
      detectMode = 'on';
      setBig(pipe, false);
      if (pipe.drive !== 'rvfc') startLoop(pipe, 'rvfc');
      promptText = '【終了】「ログをコピー」を押し、チャットに貼る。その後Userscriptsを全部オフ';
      promptEnd = 0;
      logBins('最終');
      log('試験の進行は終了');
      return;
    }
    curPhaseIdx = k;
    curPhase = newAcc();
    curPhase.srcStart = playTotal(pipe.video);
    applyPhase(pipe, k);
    promptText = '【試験' + (k + 1) + '/' + PHASES.length + '】' + PHASES[k].text;
    promptEnd = performance.now() + PHASE_SEC * 1000 * TS;
    log('試験' + (k + 1) + '/' + PHASES.length + ' 開始：' + PHASES[k].name);
    pipe.timers.push(
      setTimeout(function () {
        runPhase(pipe, k + 1);
      }, PHASE_SEC * 1000 * TS)
    );
  }
  function startSession(pipe) {
    if (pipe.sess || pipe.stopped) return;
    pipe.sess = true;
    log('試験の進行を開始。これ以降、画面の指示どおりにする（動かず正面で座る）');
    runPhase(pipe, 0);
  }

  // ====== 数字の更新（1秒ごと） ======
  function logSummary(pipe, sec) {
    log(
      '【経過' + sec + '秒】出力' + S.out + ' 検出' + S.det + ' 検出' + r1(S.detAvg) + 'ms(最大' + r0(runDetMax) + ') 処理' +
        r1(S.procAvg) + 'ms(最大' + r0(runProcMax) + ') 測定' + r1(S.metAvg) + 'ms 見失い' + lostCount + ' 待機' +
        S.standbyPct + '% 到着' + S.pres + ' カメラ遅れ平均' + (lagN ? r0(lagSum / lagN) : '-') + 'ms 最大' + r0(lagMax) + 'ms'
    );
    log('待機の内訳 ' + safeJson(reasonCount));
  }
  function tickStats() {
    S.out = C.out;
    S.det = C.det;
    S.P1 = C.P1;
    S.P2 = C.P2;
    S.P3 = C.P3;
    S.raf = C.raf;
    S.pres = C.pres;
    S.skip = C.skip;
    C.out = 0;
    C.det = 0;
    C.P1 = 0;
    C.P2 = 0;
    C.P3 = 0;
    C.raf = 0;
    C.pres = 0;
    C.skip = 0;
    var d = avgMax(detSamples);
    var p = avgMax(procSamples);
    var m = avgMax(metSamples);
    S.detAvg = d[0];
    S.procAvg = p[0];
    S.metAvg = m[0];
    detSamples = [];
    procSamples = [];
    metSamples = [];
    var tot = winFace + winStandby;
    S.standbyPct = tot ? Math.round((100 * winStandby) / tot) : 0;
    winFace = 0;
    winStandby = 0;
    if (curPhase) {
      var a = curPhase;
      a.secs++;
      a.out += S.out;
      a.proc += S.procAvg;
      a.det += S.detAvg;
      a.P1 += S.P1;
      a.P2 += S.P2;
      a.P3 += S.P3;
      a.raf += S.raf;
      a.pres += S.pres;
      a.skip += S.skip;
    }
    updateHead();
  }
  function avgMax(a) {
    var s = 0;
    var m = 0;
    for (var i = 0; i < a.length; i++) {
      s += a[i];
      if (a[i] > m) m = a[i];
    }
    return [a.length ? s / a.length : 0, m];
  }

  // ====== パイプライン（本物のカメラ→顔認識→覆い→出力）の開始と停止 ======
  function startPipeline(facing) {
    var pipe = { key: facing, stopped: false, active: 0, teardownTimer: null, timers: [], els: [] };
    var reqV = { facingMode: facing, width: { ideal: 960 }, height: { ideal: 720 } };
    return origGUM({ video: reqV })
      .then(function (rs) {
        pipe.realStream = rs;
        var rt = rs.getVideoTracks()[0];
        var info = { label: '', settings: {}, caps: null };
        try {
          info.label = rt.label;
        } catch (e) {}
        try {
          info.settings = rt.getSettings();
        } catch (e) {}
        try {
          if (rt.getCapabilities) info.caps = rt.getCapabilities();
        } catch (e) {}
        pipe.info = info;
        log('本物のカメラを開いた label=' + info.label + ' settings=' + safeJson(info.settings));
        log('カメラの申告 frameRate=' + (info.settings && info.settings.frameRate));
        var v = makeHiddenVideo();
        pipe.els.push(v);
        pipe.video = v;
        v.srcObject = rs;
        playQuiet(v, '本物video');
        return waitForSize(v, 4000);
      })
      .then(function () {
        var v = pipe.video;
        pipe.w = v.videoWidth || 720;
        pipe.h = v.videoHeight || 960;
        var canvas = document.createElement('canvas');
        canvas.width = pipe.w;
        canvas.height = pipe.h;
        canvas.style.cssText =
          'position:fixed;right:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
        (document.body || document.documentElement).appendChild(canvas);
        pipe.canvas = canvas;
        pipe.ctx = canvas.getContext('2d');
        drawStandby(pipe.ctx, pipe.w, pipe.h, '起動中');
        log('出力の大きさ ' + pipe.w + 'x' + pipe.h);

        // 別の小窓（同じカメラ映像を別のvideoで受ける）：隠し(2px)・大(120x160)・非表示(display:none)
        addProbe(pipe, 'P1', HIDDEN_CSS, '小窓隠し');
        addProbe(
          pipe,
          'P2',
          'position:fixed;right:0;top:0;width:120px;height:160px;opacity:0.3;pointer-events:none;z-index:2147483000;',
          '小窓大'
        );
        addProbe(pipe, 'P3', 'display:none;', '小窓非表示');
        startRafCounter(pipe);

        startLoop(pipe, 'rvfc');
        pipe.timers.push(setInterval(tickStats, 1000));
        [20, 60, 120, 300].forEach(function (sec) {
          pipe.timers.push(
            setTimeout(function () {
              if (!pipe.stopped) logSummary(pipe, sec);
            }, sec * 1000 * TS)
          );
        });
        loadMediaPipe().then(
          function () {
            startSession(pipe);
          },
          function () {
            log('顔認識が使えないため、試験の進行は始めない');
          }
        );
        return pipe;
      });
  }

  function stopPipeline(pipe) {
    if (!pipe || pipe.stopped) return;
    pipe.stopped = true;
    if (pipe.teardownTimer) clearTimeout(pipe.teardownTimer);
    pipe.timers.forEach(function (id) {
      clearTimeout(id);
      clearInterval(id);
    });
    try {
      if (pipe.realStream)
        pipe.realStream.getTracks().forEach(function (t) {
          t.stop();
        });
    } catch (e) {}
    try {
      if (pipe.pc1) pipe.pc1.close();
      if (pipe.pc2) pipe.pc2.close();
    } catch (e) {}
    pipe.els.slice().forEach(function (el) {
      try {
        el.srcObject = null;
        if (el.parentNode) el.parentNode.removeChild(el);
      } catch (e) {}
    });
    try {
      if (pipe.canvas && pipe.canvas.parentNode) pipe.canvas.parentNode.removeChild(pipe.canvas);
    } catch (e) {}
    if (curPipe === pipe) {
      curPipe = null;
      curPipeP = null;
      curKey = null;
    }
    log('パイプラインを止めた（本物のカメラも停止）');
  }
  function scheduleTeardown(pipe) {
    if (pipe.teardownTimer) clearTimeout(pipe.teardownTimer);
    pipe.teardownTimer = setTimeout(function () {
      if (pipe.active <= 0) stopPipeline(pipe);
    }, 5000);
  }
  function ensurePipeline(facing) {
    if (curPipe && !curPipe.stopped && curPipe.key === facing) {
      if (curPipe.teardownTimer) {
        clearTimeout(curPipe.teardownTimer);
        curPipe.teardownTimer = null;
      }
      return Promise.resolve(curPipe);
    }
    if (curPipeP && curKey === facing) return curPipeP;
    if (curPipe) stopPipeline(curPipe);
    curKey = facing;
    var p = startPipeline(facing).then(
      function (pipe) {
        curPipe = pipe;
        return pipe;
      },
      function (e) {
        if (curPipeP === p) {
          curPipeP = null;
          curKey = null;
        }
        throw e;
      }
    );
    curPipeP = p;
    return p;
  }

  // ====== mediaDevices の差し替え ======
  var md = navigator.mediaDevices;
  var origGUM = null;
  var origEnum = null;

  function getFacing(v) {
    if (v && typeof v === 'object' && v.facingMode) {
      var fm = v.facingMode;
      if (Array.isArray(fm)) fm = fm[0];
      if (fm && typeof fm === 'object') fm = fm.exact || fm.ideal;
      if (typeof fm === 'string') return fm;
    }
    return 'user';
  }
  function setLabel(track, text) {
    try {
      Object.defineProperty(track, 'label', { value: text, configurable: true });
    } catch (e) {}
  }
  function applyInfo(track, info, w, h, reqVideo) {
    setLabel(track, info.label || 'Camera');
    var s = {};
    for (var k in info.settings) s[k] = info.settings[k];
    s.width = w;
    s.height = h;
    s.aspectRatio = w / h;
    s.frameRate = 30;
    track.getSettings = function () {
      var c = {};
      for (var k2 in s) c[k2] = s[k2];
      return c;
    };
    if (info.caps) {
      track.getCapabilities = function () {
        return info.caps;
      };
    }
    track.getConstraints = function () {
      return typeof reqVideo === 'object' ? reqVideo : {};
    };
    track.applyConstraints = function () {
      return Promise.resolve();
    };
  }
  var TRACK_FUNCS = ['getSettings', 'getCapabilities', 'getConstraints', 'applyConstraints', 'stop', 'clone', 'addEventListener'];
  function wrapTrack(track, tag) {
    TRACK_FUNCS.forEach(function (name) {
      var o = track[name];
      if (typeof o !== 'function') {
        log(tag + ' ' + name + 'は存在しない');
        return;
      }
      track[name] = function () {
        var extra = name === 'addEventListener' ? ' ' + arguments[0] : '';
        var key = tag + name + extra;
        seen[key] = (seen[key] || 0) + 1;
        var quiet = seen[key] > 2;
        var r;
        try {
          r = o.apply(track, arguments);
        } catch (e) {
          log(tag + ' ' + name + extra + ' で例外 ' + (e && e.name));
          throw e;
        }
        if (!quiet) {
          if (name === 'getSettings') log(tag + ' getSettings → ' + short(safeJson(r), 100));
          else log(tag + ' ' + name + extra + ' 呼ばれた');
        }
        return r;
      };
    });
  }
  function makeOutStream(pipe) {
    var stream = pipe.canvas.captureStream(30);
    var track = stream.getVideoTracks()[0];
    pipe.active++;
    var origStop = track.stop.bind(track);
    var stopped = false;
    track.stop = function () {
      if (stopped) return;
      stopped = true;
      origStop();
      pipe.active--;
      if (pipe.active <= 0) scheduleTeardown(pipe);
    };
    return stream;
  }

  if (!md || !md.getUserMedia) {
    log('mediaDevicesが見つからない');
    return;
  }
  origGUM = md.getUserMedia.bind(md);
  origEnum = md.enumerateDevices ? md.enumerateDevices.bind(md) : null;

  md.getUserMedia = function (constraints) {
    calls++;
    var n = calls;
    log('#' + n + ' 要求 ' + short(safeJson(constraints), 110));
    var wantVideo = constraints && constraints.video;
    if (!wantVideo) {
      return origGUM(constraints).then(
        function (s) {
          log('#' + n + ' 本物を返した ' + describe(s));
          return s;
        },
        function (e) {
          log('#' + n + ' 失敗 ' + (e && e.name));
          throw e;
        }
      );
    }
    var v = constraints.video;
    return ensurePipeline(getFacing(v)).then(
      function (pipe) {
        var stream = makeOutStream(pipe);
        var vt = stream.getVideoTracks()[0];
        applyInfo(vt, pipe.info, pipe.w, pipe.h, v);
        wrapTrack(vt, 'V7出力');
        if (!constraints.audio) {
          log('#' + n + ' 加工映像を返した ' + describe(stream));
          return stream;
        }
        return origGUM({ audio: constraints.audio }).then(
          function (a) {
            a.getAudioTracks().forEach(function (t) {
              stream.addTrack(t);
            });
            log('#' + n + ' 加工映像＋マイクを返した ' + describe(stream));
            return stream;
          },
          function (e) {
            log('#' + n + ' マイク失敗 ' + (e && e.name) + '／映像のみ返した');
            return stream;
          }
        );
      },
      function (e) {
        log('#' + n + ' カメラを開けない ' + (e && e.name));
        throw e;
      }
    );
  };

  if (origEnum) {
    md.enumerateDevices = function () {
      return origEnum().then(
        function (list) {
          var vc = 0;
          var ac = 0;
          list.forEach(function (x) {
            if (x.kind === 'videoinput') vc++;
            else if (x.kind === 'audioinput') ac++;
          });
          seen.enumCount = (seen.enumCount || 0) + 1;
          if (seen.enumCount <= 2) log('enumerateDevices: カメラ' + vc + '／マイク' + ac);
          return list;
        },
        function (e) {
          log('enumerateDevices失敗 ' + (e && e.name));
          throw e;
        }
      );
    };
  }

  // ====== Stripchat側のvideo要素への映像セットを記録 ======
  try {
    var d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    if (d && d.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) {
          try {
            if (v && !this.__v5) {
              log('Stripchatのvideoに映像セット ' + describe(v));
              var el = this;
              el.addEventListener(
                'loadedmetadata',
                function () {
                  log('Stripchatのvideo読み込み ' + el.videoWidth + 'x' + el.videoHeight);
                },
                { once: true }
              );
            }
          } catch (e) {}
          return d.set.call(this, v);
        }
      });
    }
  } catch (e) {}

  function scanVideos(tag) {
    try {
      var vs = document.querySelectorAll('video');
      var total = 0;
      var withSrc = 0;
      var sizes = [];
      for (var i = 0; i < vs.length; i++) {
        if (vs[i].__v5) continue;
        total++;
        if (vs[i].srcObject) {
          withSrc++;
          sizes.push(vs[i].videoWidth + 'x' + vs[i].videoHeight);
        }
      }
      log(tag + ' Stripchatのvideo要素' + total + '個／映像つき' + withSrc + '個 ' + sizes.join(','));
    } catch (e) {}
  }
  setTimeout(function () {
    scanVideos('8秒後');
  }, 8000);
  setTimeout(function () {
    scanVideos('20秒後');
  }, 20000);
})();
