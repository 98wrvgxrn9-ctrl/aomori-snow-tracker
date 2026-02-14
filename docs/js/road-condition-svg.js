// road-condition-svg.js
// 路面状況を「上から見た道路断面図」で表示する
// 本来の車線数 vs 雪による実質車線、わだち・凍結の走りにくさを可視化

(function() {
  'use strict';

  var W = 300, H = 160;

  // レベル別パラメータ
  // origLanes: 本来の車線数, usableLanes: 実質車線数
  // snowIntrude: 左右の雪の侵食幅(0-1), rutDepth: わだちの深さ(0-1)
  // surfaceType: 路面タイプ
  var LEVEL_PARAMS = {
    clear:    { origLanes: 2, usableLanes: 2, snowIntrude: 0,    rutDepth: 0,   surfaceType: 'dry',    surfaceColor: '#555',   rutColor: 'none' },
    caution:  { origLanes: 2, usableLanes: 2, snowIntrude: 0.1,  rutDepth: 0.2, surfaceType: 'wet',    surfaceColor: '#5a6272', rutColor: '#4a5262' },
    warning:  { origLanes: 2, usableLanes: 1.5, snowIntrude: 0.25, rutDepth: 0.5, surfaceType: 'packed', surfaceColor: '#b0b8c0', rutColor: '#8a929a' },
    danger:   { origLanes: 2, usableLanes: 1, snowIntrude: 0.4,  rutDepth: 0.8, surfaceType: 'icy',    surfaceColor: '#c8d8e8', rutColor: '#90a0b0' },
    critical: { origLanes: 2, usableLanes: 0.5, snowIntrude: 0.55, rutDepth: 1.0, surfaceType: 'icy',   surfaceColor: '#d8e4f0', rutColor: '#a0b0c0' },
  };

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

    // --- レイアウト定数 ---
    var roadTop = 28;      // 道路の上端Y
    var roadBottom = H - 28; // 道路の下端Y
    var roadH = roadBottom - roadTop;
    var roadLeft = 30;     // 本来の道路左端X
    var roadRight = W - 30; // 本来の道路右端X
    var roadW = roadRight - roadLeft;
    var laneW = roadW / p.origLanes; // 1車線の幅

    // 雪の侵食幅（ピクセル）
    var snowLeftW = roadW * p.snowIntrude * 0.5;
    var snowRightW = roadW * p.snowIntrude * 0.5;
    var usableLeft = roadLeft + snowLeftW;
    var usableRight = roadRight - snowRightW;
    var usableW = usableRight - usableLeft;

    // --- 背景 ---
    parts.push(el('rect', { x: 0, y: 0, width: W, height: H, fill: '#f5f5f0', rx: 4 }));

    // --- 歩道（道路の外側） ---
    parts.push(el('rect', { x: 5, y: roadTop, width: roadLeft - 7, height: roadH, fill: '#e0ddd5', rx: 2 }));
    parts.push(el('rect', { x: roadRight + 2, y: roadTop, width: roadLeft - 7, height: roadH, fill: '#e0ddd5', rx: 2 }));

    // --- 本来の道路（アスファルト） ---
    parts.push(el('rect', { x: roadLeft, y: roadTop, width: roadW, height: roadH, fill: '#666', rx: 1 }));

    // --- 本来の車線区分（白破線） ---
    for (var i = 1; i < p.origLanes; i++) {
      var lx = roadLeft + laneW * i;
      // 破線で表示
      for (var dy = 0; dy < roadH; dy += 14) {
        var segH = Math.min(8, roadH - dy);
        parts.push(el('rect', { x: lx - 0.5, y: roadTop + dy, width: 1, height: segH, fill: '#fff', opacity: '0.5' }));
      }
    }

    // --- 中央線（黄色実線） ---
    var cx = roadLeft + roadW / 2;
    parts.push(el('rect', { x: cx - 1, y: roadTop, width: 2, height: roadH, fill: '#f1c40f', opacity: '0.7' }));

    // --- 路面状態（実際の走行面） ---
    if (p.surfaceType !== 'dry') {
      parts.push(el('rect', { x: usableLeft, y: roadTop, width: usableW, height: roadH, fill: p.surfaceColor, opacity: '0.6', rx: 1 }));
    }

    // --- 雪壁（左右から侵食） ---
    if (snowLeftW > 2) {
      // 左雪壁：ギザギザの雪山
      var snowPath = 'M' + roadLeft + ',' + roadTop;
      for (var sy = 0; sy <= roadH; sy += 12) {
        var jag = snowLeftW * (0.8 + Math.sin(sy * 0.5) * 0.2);
        snowPath += ' L' + (roadLeft + jag) + ',' + (roadTop + sy);
      }
      snowPath += ' L' + roadLeft + ',' + roadBottom + ' Z';
      parts.push(el('path', { d: snowPath, fill: '#fff', stroke: '#d0d8e0', 'stroke-width': 0.5 }));

      // 右雪壁
      var snowPathR = 'M' + roadRight + ',' + roadTop;
      for (var sy = 0; sy <= roadH; sy += 12) {
        var jag = snowRightW * (0.8 + Math.cos(sy * 0.4) * 0.2);
        snowPathR += ' L' + (roadRight - jag) + ',' + (roadTop + sy);
      }
      snowPathR += ' L' + roadRight + ',' + roadBottom + ' Z';
      parts.push(el('path', { d: snowPathR, fill: '#fff', stroke: '#d0d8e0', 'stroke-width': 0.5 }));
    }

    // --- わだち（走行痕） ---
    if (p.rutDepth > 0) {
      var rutW = 2 + p.rutDepth * 3; // わだちの太さ
      var rutOpacity = 0.2 + p.rutDepth * 0.4;
      // 左タイヤ痕・右タイヤ痕（実質走行エリア内）
      var rutCenter = (usableLeft + usableRight) / 2;
      var rutSpacing = usableW * 0.25;
      // 上り車線のわだち
      if (usableW > 30) {
        parts.push(el('rect', { x: rutCenter - rutSpacing - rutW / 2, y: roadTop + 2, width: rutW, height: roadH - 4, fill: p.rutColor, opacity: rutOpacity, rx: 1 }));
        parts.push(el('rect', { x: rutCenter + rutSpacing - rutW / 2, y: roadTop + 2, width: rutW, height: roadH - 4, fill: p.rutColor, opacity: rutOpacity, rx: 1 }));
      }
      // 深いわだちは波線で凹凸を表現
      if (p.rutDepth >= 0.5) {
        for (var ry = roadTop + 5; ry < roadBottom - 5; ry += 8) {
          var bump = p.rutDepth * 2;
          parts.push(el('line', {
            x1: rutCenter - rutSpacing - bump, y1: ry,
            x2: rutCenter - rutSpacing + bump, y2: ry + 4,
            stroke: p.rutColor, 'stroke-width': 1, opacity: rutOpacity * 0.7
          }));
        }
      }
    }

    // --- スタック車（criticalのみ） ---
    if (level === 'critical') {
      var carX = rutCenter || (W / 2);
      var carY = roadTop + roadH / 2 - 6;
      parts.push(el('rect', { x: carX - 10, y: carY, width: 20, height: 12, rx: 2, fill: '#c0392b', opacity: '0.8' }));
      parts.push(el('rect', { x: carX - 6, y: carY + 2, width: 6, height: 4, rx: 1, fill: '#85c1e9', opacity: '0.6' }));
      // 警告マーク
      parts.push(el('text', { x: carX + 14, y: carY + 10, 'font-size': '11', fill: '#c0392b', 'font-weight': 'bold' }, '!!'));
    }

    // --- 寸法表示: 本来の幅 ---
    // 上部に「本来2車線」
    parts.push(el('line', { x1: roadLeft, y1: roadTop - 8, x2: roadRight, y2: roadTop - 8, stroke: '#999', 'stroke-width': 0.5 }));
    parts.push(el('line', { x1: roadLeft, y1: roadTop - 12, x2: roadLeft, y2: roadTop - 4, stroke: '#999', 'stroke-width': 0.5 }));
    parts.push(el('line', { x1: roadRight, y1: roadTop - 12, x2: roadRight, y2: roadTop - 4, stroke: '#999', 'stroke-width': 0.5 }));
    parts.push(el('text', { x: (roadLeft + roadRight) / 2, y: roadTop - 12, 'font-size': '9', fill: '#999', 'text-anchor': 'middle' }, '本来 ' + p.origLanes + '車線'));

    // --- 寸法表示: 実質の幅 ---
    if (p.snowIntrude > 0) {
      parts.push(el('line', { x1: usableLeft, y1: roadBottom + 8, x2: usableRight, y2: roadBottom + 8, stroke: prediction.color, 'stroke-width': 1 }));
      parts.push(el('line', { x1: usableLeft, y1: roadBottom + 4, x2: usableLeft, y2: roadBottom + 12, stroke: prediction.color, 'stroke-width': 0.5 }));
      parts.push(el('line', { x1: usableRight, y1: roadBottom + 4, x2: usableRight, y2: roadBottom + 12, stroke: prediction.color, 'stroke-width': 0.5 }));
      var usableLabel = p.usableLanes < 1 ? '実質 すれ違い困難' : '実質 ' + p.usableLanes + '車線';
      parts.push(el('text', { x: (usableLeft + usableRight) / 2, y: roadBottom + 20, 'font-size': '10', fill: prediction.color, 'text-anchor': 'middle', 'font-weight': 'bold' }, usableLabel));
    }

    // --- 走りにくさインジケーター（右端） ---
    var barX = W - 18;
    var barTop = roadTop + 4;
    var barH = roadH - 8;
    var fillH = barH * p.rutDepth;
    // 背景バー
    parts.push(el('rect', { x: barX, y: barTop, width: 8, height: barH, fill: '#e0e0e0', rx: 3 }));
    // 値バー（下から上へ）
    if (fillH > 0) {
      parts.push(el('rect', { x: barX, y: barTop + barH - fillH, width: 8, height: fillH, fill: prediction.color, rx: 3, opacity: '0.8' }));
    }
    parts.push(el('text', { x: barX + 4, y: barTop - 4, 'font-size': '7', fill: '#999', 'text-anchor': 'middle' }, '凹凸'));

    // --- ラベルバッジ（左上） ---
    var badgeColor = prediction.color || '#27ae60';
    var badgeLabel = prediction.label || '良好';
    var badgeW = badgeLabel.length * 12 + 12;
    parts.push(el('rect', { x: 4, y: 3, width: badgeW, height: 20, rx: 10, fill: badgeColor, opacity: '0.9' }));
    parts.push(el('text', { x: 4 + badgeW / 2, y: 17, 'font-size': '11', fill: '#fff', 'font-weight': 'bold', 'text-anchor': 'middle' }, badgeLabel));

    // --- 凡例アイコン（路面タイプ） ---
    var surfaceLabels = { dry: '乾燥', wet: '湿潤', packed: '圧雪', icy: '凍結' };
    var surfLabel = surfaceLabels[p.surfaceType] || '';
    if (surfLabel) {
      parts.push(el('text', { x: W - 4, y: 16, 'font-size': '9', fill: '#888', 'text-anchor': 'end' }, '路面: ' + surfLabel));
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" '
      + 'style="width:100%;max-width:300px;height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.12);background:#f5f5f0">'
      + parts.join('')
      + '</svg>';
  }

  // 路面状況カードHTML生成
  function renderRoadConditionCard(prediction) {
    if (!prediction) return '';

    var svg = generateRoadSVG(prediction);
    var p = LEVEL_PARAMS[prediction.level] || LEVEL_PARAMS.clear;

    var confidenceLabel = (window.RoadPredict && window.RoadPredict.CONFIDENCE_LABELS[prediction.confidence]) || prediction.confidence;
    var sourceLabel = (window.RoadPredict && window.RoadPredict.SOURCE_LABELS[prediction.source]) || prediction.source;

    var html = '<div style="margin-top:10px;padding:10px;background:#f8f9fa;border-radius:8px;border:1px solid #e0e0e0">';
    html += '<div style="font-size:12px;font-weight:bold;color:#555;margin-bottom:6px">路面状況予測（上から見た図）</div>';
    html += '<div style="text-align:center;margin-bottom:8px">' + svg + '</div>';

    // テキスト情報
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">';
    html += '<span style="font-size:16px;font-weight:bold;color:' + prediction.color + '">' + prediction.label + '</span>';
    html += '<span style="font-size:12px;color:#888">スコア ' + prediction.score + '/100</span>';
    html += '</div>';

    // 車線情報
    var laneText = p.origLanes + '車線 → ';
    if (p.usableLanes < 1) {
      laneText += '<span style="color:#c0392b;font-weight:bold">すれ違い困難</span>';
    } else if (p.usableLanes < p.origLanes) {
      laneText += '<span style="color:' + prediction.color + ';font-weight:bold">実質' + p.usableLanes + '車線</span>';
    } else {
      laneText += '<span style="color:#27ae60">通常通り</span>';
    }
    html += '<div style="font-size:11px;color:#555;margin-bottom:2px">車線: ' + laneText + '</div>';

    // 走行性
    var driveLabels = ['快適', '概ね良好', 'ガタガタ', '非常に悪い', '走行困難'];
    var driveIdx = Math.min(Math.floor(p.rutDepth * 4.99), 4);
    html += '<div style="font-size:11px;color:#555;margin-bottom:2px">走行性: ' + driveLabels[driveIdx] + '　路面: ' + prediction.surface + '</div>';

    html += '<div style="font-size:10px;color:#aaa;margin-top:4px">';
    html += sourceLabel + ' / 信頼度: ' + confidenceLabel;
    html += '</div>';
    html += '</div>';

    return html;
  }

  // グローバル公開
  window.RoadSVG = {
    generateRoadSVG: generateRoadSVG,
    renderRoadConditionCard: renderRoadConditionCard,
  };

})();
