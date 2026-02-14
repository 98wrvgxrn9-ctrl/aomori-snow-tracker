// road-condition-svg.js
// 路面状況の擬似3D SVGイラストを生成する
// ※innerHTML経由で挿入するため、SVG固有要素(linearGradient等)を避け単色で描画

(function() {
  'use strict';

  var W = 300, H = 180;
  var VP_X = 150, VP_Y = 40; // 消失点

  // 空の色（上部）
  var SKY_COLORS = {
    clear:    '#87CEEB',
    caution:  '#b0c4de',
    warning:  '#9aa8b5',
    danger:   '#7a8690',
    critical: '#5a6268',
  };

  // 地平線付近の色
  var HORIZON_COLORS = {
    clear:    '#c5e8f7',
    caution:  '#d4dfe8',
    warning:  '#bfc8cf',
    danger:   '#a0a8af',
    critical: '#888e93',
  };

  // 路面色
  var ROAD_COLORS = {
    clear:    { fill: '#444', stroke: '#333' },
    caution:  { fill: '#5a6272', stroke: '#4a5262' },
    warning:  { fill: '#b8bcc4', stroke: '#a0a4ac' },
    danger:   { fill: '#c8d8e8', stroke: '#a8b8c8' },
    critical: { fill: '#d0e0f0', stroke: '#b0c0d0' },
  };

  function attr(obj) {
    var s = '';
    for (var k in obj) {
      s += ' ' + k + '="' + obj[k] + '"';
    }
    return s;
  }

  function el(tag, attrs, content) {
    if (content != null) {
      return '<' + tag + attr(attrs) + '>' + content + '</' + tag + '>';
    }
    return '<' + tag + attr(attrs) + '/>';
  }

  function generateRoadSVG(prediction) {
    if (!prediction) return '';

    var level = prediction.level || 'clear';
    var skyColor = SKY_COLORS[level] || SKY_COLORS.clear;
    var horizonColor = HORIZON_COLORS[level] || HORIZON_COLORS.clear;
    var road = ROAD_COLORS[level] || ROAD_COLORS.clear;
    var snowAmount = getSnowHeight(level);

    var parts = [];

    // Layer 1: 空（上半分と下半分の2色で擬似グラデーション）
    parts.push(el('rect', { x: 0, y: 0, width: W, height: H / 2, fill: skyColor }));
    parts.push(el('rect', { x: 0, y: H / 2 - 10, width: W, height: H / 2 + 10, fill: horizonColor }));

    // Layer 2: 道路（台形 - 消失点に向かう遠近法）
    var roadBottom = H;
    var roadLB = 60, roadRB = 240;
    var roadLT = VP_X - 20, roadRT = VP_X + 20;
    var roadTopY = VP_Y + 20;

    var roadD = 'M' + roadLB + ',' + roadBottom
      + ' L' + roadLT + ',' + roadTopY
      + ' L' + roadRT + ',' + roadTopY
      + ' L' + roadRB + ',' + roadBottom + ' Z';
    parts.push(el('path', { d: roadD, fill: road.fill, stroke: road.stroke, 'stroke-width': 1 }));

    // 凍結時の光沢オーバーレイ（白の半透明）
    if (level === 'danger' || level === 'critical') {
      parts.push(el('path', { d: roadD, fill: '#fff', opacity: '0.15' }));
    }

    // Layer 3: 雪壁（道路両脇）
    if (snowAmount > 0) {
      var snowH = 15 + snowAmount * 25;
      var intrude = level === 'critical' ? 15 : (level === 'danger' ? 8 : 0);

      // 左雪壁
      parts.push(el('path', {
        d: 'M0,' + roadBottom
          + ' L0,' + (roadBottom - snowH * 0.6)
          + ' L' + (roadLB - 20) + ',' + (roadBottom - snowH * 0.3)
          + ' L' + (roadLB + intrude) + ',' + roadBottom + ' Z',
        fill: '#f0f4f8', stroke: '#dce4ea', 'stroke-width': 0.5, opacity: '0.9'
      }));

      // 右雪壁
      parts.push(el('path', {
        d: 'M' + W + ',' + roadBottom
          + ' L' + W + ',' + (roadBottom - snowH * 0.6)
          + ' L' + (roadRB + 20) + ',' + (roadBottom - snowH * 0.3)
          + ' L' + (roadRB - intrude) + ',' + roadBottom + ' Z',
        fill: '#f0f4f8', stroke: '#dce4ea', 'stroke-width': 0.5, opacity: '0.9'
      }));

      // 奥の雪壁（左右）
      parts.push(el('path', {
        d: 'M0,' + (roadTopY + 30) + ' L0,' + (roadTopY + 10)
          + ' L' + (roadLT - 10) + ',' + (roadTopY + 20)
          + ' L' + roadLT + ',' + (roadTopY + 30) + ' Z',
        fill: '#e8edf2', opacity: '0.7'
      }));
      parts.push(el('path', {
        d: 'M' + W + ',' + (roadTopY + 30) + ' L' + W + ',' + (roadTopY + 10)
          + ' L' + (roadRT + 10) + ',' + (roadTopY + 20)
          + ' L' + roadRT + ',' + (roadTopY + 30) + ' Z',
        fill: '#e8edf2', opacity: '0.7'
      }));
    }

    // Layer 4: 車線表示（乾燥・湿潤のみ）
    if (level === 'clear' || level === 'caution') {
      var segs = 6;
      for (var i = 0; i < segs; i++) {
        var t1 = 0.2 + (i / segs) * 0.7;
        var t2 = t1 + 0.04;
        var y1 = roadTopY + (roadBottom - roadTopY) * t1;
        var y2 = roadTopY + (roadBottom - roadTopY) * t2;
        var lw = 1 + t1 * 2;
        // 中央線（黄）
        parts.push(el('line', {
          x1: VP_X, y1: y1, x2: VP_X, y2: y2,
          stroke: '#f1c40f', 'stroke-width': lw, opacity: level === 'clear' ? '0.8' : '0.4'
        }));
        // 左路肩（白）
        var lx1 = roadLT + (roadLB - roadLT) * t1 + 5;
        var lx2 = roadLT + (roadLB - roadLT) * t2 + 5;
        parts.push(el('line', {
          x1: lx1, y1: y1, x2: lx2, y2: y2,
          stroke: '#fff', 'stroke-width': 1 + t1, opacity: '0.6'
        }));
      }
    }

    // Layer 5: 危険表示
    if (level === 'danger' || level === 'warning') {
      // わだち線
      for (var side = -1; side <= 1; side += 2) {
        var off = side * 25;
        parts.push(el('path', {
          d: 'M' + (VP_X + off * 0.3) + ',' + (roadTopY + 30)
            + ' Q' + (VP_X + off * 0.6) + ',' + (H * 0.65)
            + ' ' + (VP_X + off) + ',' + roadBottom,
          fill: 'none', stroke: 'rgba(0,0,0,0.15)',
          'stroke-width': 2 + Math.abs(off) * 0.05,
          'stroke-dasharray': '4,6'
        }));
      }
    }

    if (level === 'critical') {
      // スタック車シルエット
      var carY = H * 0.65;
      var carW = 32, carH = 14;
      var carX = VP_X - carW / 2 + 5;
      parts.push(el('rect', { x: carX, y: carY, width: carW, height: carH, rx: 3, fill: '#c0392b', opacity: '0.7' }));
      parts.push(el('rect', { x: carX + 6, y: carY + 2, width: 10, height: 6, rx: 1, fill: '#85c1e9', opacity: '0.6' }));
      parts.push(el('circle', { cx: carX + 7, cy: carY + carH, r: 3, fill: '#2c3e50', opacity: '0.7' }));
      parts.push(el('circle', { cx: carX + carW - 7, cy: carY + carH, r: 3, fill: '#2c3e50', opacity: '0.7' }));
      parts.push(el('text', { x: carX + carW + 8, y: carY + 5, 'font-size': '14', fill: '#c0392b', 'font-weight': 'bold', opacity: '0.8' }, '!!'));
    }

    // Layer 6: ラベルバッジ
    var badgeColor = prediction.color || '#27ae60';
    var badgeLabel = prediction.label || '良好';
    var badgeW = badgeLabel.length * 14 + 16;
    parts.push(el('rect', { x: W - badgeW - 8, y: 8, width: badgeW, height: 24, rx: 12, fill: badgeColor, opacity: '0.9' }));
    parts.push(el('text', { x: W - badgeW / 2 - 8, y: 25, 'font-size': '12', fill: '#fff', 'font-weight': 'bold', 'text-anchor': 'middle' }, badgeLabel));

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" '
      + 'style="width:100%;max-width:300px;height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.15)">'
      + parts.join('')
      + '</svg>';
  }

  function getSnowHeight(level) {
    switch (level) {
      case 'clear': return 0;
      case 'caution': return 0.2;
      case 'warning': return 0.5;
      case 'danger': return 0.8;
      case 'critical': return 1.0;
      default: return 0;
    }
  }

  // 路面状況カードHTML生成
  function renderRoadConditionCard(prediction) {
    if (!prediction) return '';

    var svg = generateRoadSVG(prediction);

    var confidenceLabel = (window.RoadPredict && window.RoadPredict.CONFIDENCE_LABELS[prediction.confidence]) || prediction.confidence;
    var sourceLabel = (window.RoadPredict && window.RoadPredict.SOURCE_LABELS[prediction.source]) || prediction.source;

    var html = '<div style="margin-top:10px;padding:10px;background:#f8f9fa;border-radius:8px;border:1px solid #e0e0e0">';
    html += '<div style="font-size:12px;font-weight:bold;color:#555;margin-bottom:6px">路面状況予測</div>';
    html += '<div style="text-align:center;margin-bottom:8px">' + svg + '</div>';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">';
    html += '<span style="font-size:16px;font-weight:bold;color:' + prediction.color + '">' + prediction.label + '</span>';
    html += '<span style="font-size:12px;color:#888">スコア ' + prediction.score + '/100</span>';
    html += '</div>';
    html += '<div style="font-size:11px;color:#777;margin-bottom:2px">';
    html += '<span>路面: ' + prediction.surface + '</span>';
    html += '<span style="margin-left:8px">積雪: ' + prediction.snow + '</span>';
    html += '</div>';
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
