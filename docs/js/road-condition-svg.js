// road-condition-svg.js
// ドライバー視点（正面）の路面状況イラスト
// 車線の本数・轍・雪壁を実用的に可視化

(function() {
  'use strict';

  var W = 300, H = 200;

  // レベル別パラメータ
  var LEVEL_PARAMS = {
    //             origLanes, usableLanes, snowWallHeight(0-3), snowIntrude(0-1), rutIndex(0-100), surfaceType
    clear:    { orig: 2, usable: 2, wallH: 0, intrude: 0,    rut: 0,   surface: 'dry' },
    caution:  { orig: 2, usable: 2, wallH: 1, intrude: 0.05, rut: 20,  surface: 'wet' },
    warning:  { orig: 2, usable: 1, wallH: 2, intrude: 0.2,  rut: 55,  surface: 'packed' },
    danger:   { orig: 2, usable: 1, wallH: 3, intrude: 0.35, rut: 78,  surface: 'icy' },
    critical: { orig: 2, usable: 0, wallH: 3, intrude: 0.5,  rut: 95,  surface: 'icy' },
  };

  var WALL_LABELS = ['なし', '低', '中', '高'];
  var SURFACE_LABELS = { dry: '乾燥', wet: '湿潤', packed: '圧雪', icy: '凍結' };

  // usableLanes の説明
  function laneDescription(orig, usable) {
    if (usable >= orig) return '通常通り';
    if (usable >= 1.5) return 'やや狭い';
    if (usable >= 1) return '交互通行レベル';
    if (usable >= 0.5) return 'すれ違い困難';
    return 'スタック危険';
  }

  // 轍の説明
  function rutDescription(rut) {
    if (rut <= 10) return '平坦';
    if (rut <= 30) return '浅い轍';
    if (rut <= 55) return 'ハンドル取られ注意';
    if (rut <= 80) return '深い轍・車体擦り注意';
    return '極深轍・走行困難';
  }

  function a(obj) {
    var s = '';
    for (var k in obj) s += ' ' + k + '="' + obj[k] + '"';
    return s;
  }

  function el(tag, attrs, content) {
    if (content != null) return '<' + tag + a(attrs) + '>' + content + '</' + tag + '>';
    return '<' + tag + a(attrs) + '/>';
  }

  function generateRoadSVG(prediction) {
    if (!prediction) return '';

    var level = prediction.level || 'clear';
    var p = LEVEL_PARAMS[level] || LEVEL_PARAMS.clear;
    var parts = [];

    // === レイアウト ===
    // ドライバー正面視点: 下が手前、上が奥（消失点）
    var vpX = W / 2, vpY = 38;           // 消失点
    var roadBottomL = 30, roadBottomR = W - 30; // 手前の道路端
    var roadTopL = vpX - 22, roadTopR = vpX + 22; // 奥の道路端
    var roadTopY = vpY + 15, roadBottomY = H;
    var roadH = roadBottomY - roadTopY;

    // 雪侵食で狭まった実質道路端
    var intrudeL = (roadBottomR - roadBottomL) * p.intrude * 0.5;
    var intrudeR = intrudeL;
    var usableBL = roadBottomL + intrudeL;
    var usableBR = roadBottomR - intrudeR;
    var intrudeTL = (roadTopR - roadTopL) * p.intrude * 0.4;
    var usableTL = roadTopL + intrudeTL;
    var usableTR = roadTopR - intrudeTL;

    // === 背景: 空 ===
    var skyColor = level === 'clear' ? '#87CEEB' : level === 'caution' ? '#a8bdd0' : level === 'warning' ? '#8a96a2' : '#6a747e';
    parts.push(el('rect', { x: 0, y: 0, width: W, height: H, fill: skyColor }));
    // 地面（道路外）
    parts.push(el('path', {
      d: 'M0,' + roadTopY + ' L0,' + H + ' L' + W + ',' + H + ' L' + W + ',' + roadTopY
        + ' L' + roadTopR + ',' + roadTopY + ' L' + roadBottomR + ',' + H
        + ' L' + roadBottomL + ',' + H + ' L' + roadTopL + ',' + roadTopY + ' Z',
      fill: '#d5d0c8'
    }));

    // === 道路アスファルト ===
    var roadD = 'M' + roadBottomL + ',' + roadBottomY
      + ' L' + roadTopL + ',' + roadTopY
      + ' L' + roadTopR + ',' + roadTopY
      + ' L' + roadBottomR + ',' + roadBottomY + ' Z';
    parts.push(el('path', { d: roadD, fill: '#444' }));

    // 路面状態オーバーレイ
    if (p.surface === 'wet') {
      parts.push(el('path', { d: roadD, fill: '#5a6878', opacity: '0.5' }));
    } else if (p.surface === 'packed') {
      parts.push(el('path', { d: roadD, fill: '#b0b8c0', opacity: '0.6' }));
    } else if (p.surface === 'icy') {
      parts.push(el('path', { d: roadD, fill: '#c0d0e0', opacity: '0.6' }));
      // 凍結の光沢
      parts.push(el('path', { d: roadD, fill: '#fff', opacity: '0.08' }));
    }

    // === 車線描画 ===
    // 消失点に向かう線を計算するヘルパー
    // t=0 が手前(bottom), t=1 が奥(top)
    function lerpX(bottomX, topX, t) { return bottomX + (topX - bottomX) * t; }
    function lerpY(t) { return roadBottomY + (roadTopY - roadBottomY) * t; }

    var origW = roadBottomR - roadBottomL;
    var origLaneW = origW / p.orig;
    var origWTop = roadTopR - roadTopL;
    var origLaneWTop = origWTop / p.orig;

    // 本来の車線（消失した車線は灰色破線）
    for (var li = 1; li < p.orig; li++) {
      var bx = roadBottomL + origLaneW * li;
      var tx = roadTopL + origLaneWTop * li;
      // この車線境界が雪で埋もれているか判定
      var buried = (bx < usableBL + 5) || (bx > usableBR - 5);

      if (buried) {
        // 埋没車線: 灰色破線
        for (var t = 0; t < 1; t += 0.08) {
          var x1 = lerpX(bx, tx, t);
          var y1 = lerpY(t);
          var x2 = lerpX(bx, tx, Math.min(t + 0.04, 1));
          var y2 = lerpY(Math.min(t + 0.04, 1));
          parts.push(el('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: '#777', 'stroke-width': 1, opacity: '0.3', 'stroke-dasharray': '3,5' }));
        }
      } else {
        // 使える車線: 白い破線
        for (var t = 0; t < 1; t += 0.08) {
          var x1 = lerpX(bx, tx, t);
          var y1 = lerpY(t);
          var x2 = lerpX(bx, tx, Math.min(t + 0.04, 1));
          var y2 = lerpY(Math.min(t + 0.04, 1));
          var sw = 1 + (1 - t) * 1.5;
          parts.push(el('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: '#fff', 'stroke-width': sw, opacity: '0.8' }));
        }
      }
    }

    // 中央線（黄色）— 車線が使える場合のみ
    if (p.usable >= 1) {
      var cbx = (roadBottomL + roadBottomR) / 2;
      var ctx = (roadTopL + roadTopR) / 2;
      for (var t = 0; t < 1; t += 0.06) {
        var x1 = lerpX(cbx, ctx, t);
        var y1 = lerpY(t);
        var x2 = lerpX(cbx, ctx, Math.min(t + 0.03, 1));
        var y2 = lerpY(Math.min(t + 0.03, 1));
        var sw = 1.5 + (1 - t) * 2;
        parts.push(el('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: '#f1c40f', 'stroke-width': sw, opacity: '0.7' }));
      }
    }

    // === 雪壁 ===
    if (p.wallH > 0) {
      // 雪壁の高さ（ピクセル）: 段階的に極端に
      var wallPx = [0, 18, 40, 65][p.wallH]; // なし/低/中/高
      var wallColor = '#f0f4f8';
      var wallStroke = '#d0d8e0';

      // 左雪壁（台形・手前が大きい）
      var lwb = usableBL; // 手前の雪壁右端
      var lwt = usableTL; // 奥の雪壁右端
      // 手前の雪壁上端y
      var wallBottomTopY = roadBottomY - wallPx;
      var wallTopTopY = roadTopY - wallPx * 0.35;

      parts.push(el('path', {
        d: 'M' + roadBottomL + ',' + roadBottomY
          + ' L' + roadBottomL + ',' + wallBottomTopY
          + ' L' + (lwb - 2) + ',' + (wallBottomTopY + wallPx * 0.3)
          + ' L' + lwb + ',' + roadBottomY + ' Z',
        fill: wallColor, stroke: wallStroke, 'stroke-width': 0.5
      }));
      // 奥部分
      parts.push(el('path', {
        d: 'M' + roadTopL + ',' + roadTopY
          + ' L' + roadTopL + ',' + wallTopTopY
          + ' L' + (lwt - 1) + ',' + (wallTopTopY + wallPx * 0.1)
          + ' L' + lwt + ',' + roadTopY + ' Z',
        fill: '#e8edf2', stroke: wallStroke, 'stroke-width': 0.3, opacity: '0.7'
      }));
      // 中間をつなぐ（側面）
      parts.push(el('path', {
        d: 'M' + roadBottomL + ',' + wallBottomTopY
          + ' L' + roadTopL + ',' + wallTopTopY
          + ' L' + lwt + ',' + roadTopY
          + ' L' + lwb + ',' + roadBottomY
          + ' L' + (lwb - 2) + ',' + (wallBottomTopY + wallPx * 0.3) + ' Z',
        fill: '#e4e9ee', opacity: '0.5'
      }));

      // 右雪壁
      var rwb = usableBR;
      var rwt = usableTR;
      parts.push(el('path', {
        d: 'M' + roadBottomR + ',' + roadBottomY
          + ' L' + roadBottomR + ',' + wallBottomTopY
          + ' L' + (rwb + 2) + ',' + (wallBottomTopY + wallPx * 0.3)
          + ' L' + rwb + ',' + roadBottomY + ' Z',
        fill: wallColor, stroke: wallStroke, 'stroke-width': 0.5
      }));
      parts.push(el('path', {
        d: 'M' + roadBottomR + ',' + wallBottomTopY
          + ' L' + roadTopR + ',' + wallTopTopY
          + ' L' + rwt + ',' + roadTopY
          + ' L' + rwb + ',' + roadBottomY
          + ' L' + (rwb + 2) + ',' + (wallBottomTopY + wallPx * 0.3) + ' Z',
        fill: '#e4e9ee', opacity: '0.5'
      }));
      parts.push(el('path', {
        d: 'M' + roadTopR + ',' + roadTopY
          + ' L' + roadTopR + ',' + wallTopTopY
          + ' L' + (rwt + 1) + ',' + (wallTopTopY + wallPx * 0.1)
          + ' L' + rwt + ',' + roadTopY + ' Z',
        fill: '#e8edf2', stroke: wallStroke, 'stroke-width': 0.3, opacity: '0.7'
      }));

      // 侵食ラベル（高の場合）
      if (p.wallH >= 3 && p.intrude >= 0.35) {
        parts.push(el('text', {
          x: (roadBottomL + usableBL) / 2, y: roadBottomY - 8,
          'font-size': '8', fill: '#c0392b', 'text-anchor': 'middle', 'font-weight': 'bold'
        }, '侵食'));
      }
    }

    // === 轍（わだち） ===
    if (p.rut > 15) {
      var rutAlpha = Math.min(p.rut / 100, 0.7);
      var rutWidth = 2 + (p.rut / 100) * 4;
      var usableCenterB = (usableBL + usableBR) / 2;
      var usableCenterT = (usableTL + usableTR) / 2;
      var spacingB = (usableBR - usableBL) * 0.2;
      var spacingT = (usableTR - usableTL) * 0.2;

      // 左轍・右轍
      for (var side = -1; side <= 1; side += 2) {
        var bx = usableCenterB + side * spacingB;
        var tx = usableCenterT + side * spacingT;
        // 轍のメイン線
        parts.push(el('line', {
          x1: bx, y1: roadBottomY, x2: tx, y2: roadTopY + 10,
          stroke: 'rgba(0,0,0,' + rutAlpha + ')', 'stroke-width': rutWidth
        }));
        // 深い轍: 横方向の凹凸線
        if (p.rut >= 50) {
          for (var t = 0.15; t < 0.9; t += 0.1) {
            var rx = lerpX(bx, tx, t);
            var ry = lerpY(t);
            var bumpW = rutWidth * 1.5 * (1 - t);
            parts.push(el('line', {
              x1: rx - bumpW, y1: ry, x2: rx + bumpW, y2: ry,
              stroke: 'rgba(0,0,0,' + (rutAlpha * 0.5) + ')', 'stroke-width': 0.8
            }));
          }
        }
      }
    }

    // === スタック車（criticalのみ） ===
    if (level === 'critical') {
      var carCX = W / 2 + 3;
      var carCY = roadBottomY - roadH * 0.45;
      parts.push(el('rect', { x: carCX - 12, y: carCY - 7, width: 24, height: 14, rx: 3, fill: '#c0392b', opacity: '0.85' }));
      parts.push(el('rect', { x: carCX - 7, y: carCY - 5, width: 8, height: 5, rx: 1, fill: '#85c1e9', opacity: '0.6' }));
      parts.push(el('circle', { cx: carCX - 8, cy: carCY + 7, r: 3, fill: '#2c3e50' }));
      parts.push(el('circle', { cx: carCX + 8, cy: carCY + 7, r: 3, fill: '#2c3e50' }));
      parts.push(el('text', { x: carCX + 18, y: carCY, 'font-size': '13', fill: '#c0392b', 'font-weight': 'bold' }, '!!'));
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" '
      + 'style="width:100%;max-width:300px;height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.12)">'
      + parts.join('')
      + '</svg>';
  }

  // --- カードHTML生成 ---
  function renderRoadConditionCard(prediction) {
    if (!prediction) return '';

    var level = prediction.level || 'clear';
    var p = LEVEL_PARAMS[level] || LEVEL_PARAMS.clear;
    var svg = generateRoadSVG(prediction);

    var confidenceLabel = (window.RoadPredict && window.RoadPredict.CONFIDENCE_LABELS[prediction.confidence]) || prediction.confidence;
    var sourceLabel = (window.RoadPredict && window.RoadPredict.SOURCE_LABELS[prediction.source]) || prediction.source;

    var html = '<div style="margin-top:10px;padding:10px;background:#f8f9fa;border-radius:8px;border:1px solid #e0e0e0">';

    // --- ヘッダー: タイトル + バッジ ---
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
    html += '<span style="font-size:12px;font-weight:bold;color:#555">ドライバー視点（概念図）</span>';
    html += '<span style="background:' + prediction.color + ';color:#fff;font-size:11px;font-weight:bold;padding:2px 10px;border-radius:10px">' + prediction.label + '</span>';
    html += '</div>';

    // --- 車線情報バッジ（一番目立つ位置） ---
    var laneBadgeBg, laneBadgeText;
    if (p.usable >= p.orig) {
      laneBadgeBg = '#27ae60'; laneBadgeText = '通常 ' + p.orig + '車線';
    } else if (p.usable >= 1) {
      laneBadgeBg = p.usable >= 1.5 ? '#f39c12' : '#e67e22';
      laneBadgeText = '本来' + p.orig + '車線 → 実質' + p.usable + '車線';
    } else {
      laneBadgeBg = '#c0392b';
      laneBadgeText = '本来' + p.orig + '車線 → スタック危険';
    }
    html += '<div style="background:' + laneBadgeBg + ';color:#fff;padding:6px 10px;border-radius:6px;font-size:13px;font-weight:bold;text-align:center;margin-bottom:8px">';
    html += laneBadgeText;
    var laneDesc = laneDescription(p.orig, p.usable);
    html += '<span style="font-size:10px;font-weight:normal;margin-left:8px;opacity:0.9">（' + laneDesc + '）</span>';
    html += '</div>';

    // --- SVGイラスト ---
    html += '<div style="text-align:center;margin-bottom:8px">' + svg + '</div>';

    // --- 轍走行指数 ---
    var rutBarW = Math.min(p.rut, 100);
    var rutColor = p.rut <= 30 ? '#27ae60' : p.rut <= 55 ? '#f39c12' : p.rut <= 80 ? '#e67e22' : '#c0392b';
    html += '<div style="margin-bottom:6px">';
    html += '<div style="font-size:11px;color:#555;margin-bottom:3px;display:flex;justify-content:space-between">';
    html += '<span>轍走行指数</span>';
    html += '<span style="font-weight:bold;color:' + rutColor + '">' + p.rut + '<span style="font-size:9px;color:#999">/100</span></span>';
    html += '</div>';
    // バー
    html += '<div style="height:8px;background:#e8e8e8;border-radius:4px;overflow:hidden">';
    html += '<div style="height:100%;width:' + rutBarW + '%;background:' + rutColor + ';border-radius:4px;transition:width 0.3s"></div>';
    html += '</div>';
    html += '<div style="font-size:9px;color:#888;margin-top:1px">' + rutDescription(p.rut) + '</div>';
    html += '</div>';

    // --- 詳細行 ---
    html += '<div style="display:flex;gap:12px;font-size:10px;color:#666;margin-bottom:4px">';
    html += '<span>路面: ' + SURFACE_LABELS[p.surface] + '</span>';
    html += '<span>雪壁: ' + WALL_LABELS[p.wallH] + '</span>';
    html += '<span>スコア ' + prediction.score + '/100</span>';
    html += '</div>';

    // --- ソース ---
    html += '<div style="font-size:9px;color:#aaa">';
    html += sourceLabel + ' / ' + confidenceLabel;
    html += '</div>';

    html += '</div>';
    return html;
  }

  window.RoadSVG = {
    generateRoadSVG: generateRoadSVG,
    renderRoadConditionCard: renderRoadConditionCard,
  };

})();
