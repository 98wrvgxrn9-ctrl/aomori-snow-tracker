// road-condition-svg.js
// 路面状況の擬似3D SVGイラストを生成する

(function() {
  'use strict';

  var W = 300, H = 180;
  var VP_X = 150, VP_Y = 40; // 消失点

  // 空のグラデーション色
  var SKY_COLORS = {
    clear:    { top: '#87CEEB', bottom: '#c5e8f7' },
    caution:  { top: '#b0c4de', bottom: '#d4dfe8' },
    warning:  { top: '#9aa8b5', bottom: '#bfc8cf' },
    danger:   { top: '#7a8690', bottom: '#a0a8af' },
    critical: { top: '#5a6268', bottom: '#888e93' },
  };

  // 路面色
  var ROAD_COLORS = {
    clear:    { fill: '#444', stroke: '#333' },      // 乾燥
    caution:  { fill: '#5a6272', stroke: '#4a5262' }, // 湿潤
    warning:  { fill: '#b8bcc4', stroke: '#a0a4ac' }, // 圧雪
    danger:   { fill: '#c8d8e8', stroke: '#a8b8c8' }, // 凍結
    critical: { fill: '#d0e0f0', stroke: '#b0c0d0' }, // 凍結（光沢）
  };

  function svgEl(tag, attrs) {
    var parts = ['<' + tag];
    for (var k in attrs) {
      parts.push(' ' + k + '="' + attrs[k] + '"');
    }
    parts.push('/>');
    return parts.join('');
  }

  function svgElOpen(tag, attrs) {
    var parts = ['<' + tag];
    for (var k in attrs) {
      parts.push(' ' + k + '="' + attrs[k] + '"');
    }
    parts.push('>');
    return parts.join('');
  }

  function generateRoadSVG(prediction) {
    if (!prediction) return '';

    var level = prediction.level || 'clear';
    var sky = SKY_COLORS[level] || SKY_COLORS.clear;
    var road = ROAD_COLORS[level] || ROAD_COLORS.clear;
    var snowAmount = getSnowHeight(level);

    var svg = '';
    svg += '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" ';
    svg += 'style="width:100%;max-width:300px;height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.15)">';

    // Defs: グラデーション
    svg += '<defs>';
    svg += '<linearGradient id="sky-' + level + '" x1="0" y1="0" x2="0" y2="1">';
    svg += '<stop offset="0%" stop-color="' + sky.top + '"/>';
    svg += '<stop offset="100%" stop-color="' + sky.bottom + '"/>';
    svg += '</linearGradient>';
    if (level === 'danger' || level === 'critical') {
      svg += '<linearGradient id="ice-gloss" x1="0" y1="0" x2="1" y2="1">';
      svg += '<stop offset="0%" stop-color="rgba(255,255,255,0.3)"/>';
      svg += '<stop offset="50%" stop-color="rgba(255,255,255,0.05)"/>';
      svg += '<stop offset="100%" stop-color="rgba(255,255,255,0.2)"/>';
      svg += '</linearGradient>';
    }
    svg += '</defs>';

    // Layer 1: 空
    svg += svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#sky-' + level + ')' });

    // Layer 2: 道路（台形 - 消失点に向かう遠近法）
    var roadBottom = H;
    var roadLeftBottom = 60;
    var roadRightBottom = 240;
    var roadLeftTop = VP_X - 20;
    var roadRightTop = VP_X + 20;
    var roadTopY = VP_Y + 20;

    var roadPath = 'M' + roadLeftBottom + ',' + roadBottom
      + ' L' + roadLeftTop + ',' + roadTopY
      + ' L' + roadRightTop + ',' + roadTopY
      + ' L' + roadRightBottom + ',' + roadBottom + ' Z';
    svg += svgElOpen('path', { d: roadPath, fill: road.fill, stroke: road.stroke, 'stroke-width': 1 });
    svg += '</path>';

    // 凍結時の光沢オーバーレイ
    if (level === 'danger' || level === 'critical') {
      svg += svgElOpen('path', { d: roadPath, fill: 'url(#ice-gloss)', opacity: '0.5' });
      svg += '</path>';
    }

    // Layer 3: 雪壁（道路両脇）
    if (snowAmount > 0) {
      var snowH = 15 + snowAmount * 25; // 15~40px
      var snowIntrude = level === 'critical' ? 15 : (level === 'danger' ? 8 : 0);

      // 左雪壁
      svg += svgElOpen('path', {
        d: 'M0,' + roadBottom
          + ' L0,' + (roadBottom - snowH * 0.6)
          + ' L' + (roadLeftBottom - 20) + ',' + (roadBottom - snowH * 0.3)
          + ' L' + (roadLeftBottom + snowIntrude) + ',' + roadBottom + ' Z',
        fill: '#f0f4f8', stroke: '#dce4ea', 'stroke-width': 0.5, opacity: '0.9'
      });
      svg += '</path>';

      // 右雪壁
      svg += svgElOpen('path', {
        d: 'M' + W + ',' + roadBottom
          + ' L' + W + ',' + (roadBottom - snowH * 0.6)
          + ' L' + (roadRightBottom + 20) + ',' + (roadBottom - snowH * 0.3)
          + ' L' + (roadRightBottom - snowIntrude) + ',' + roadBottom + ' Z',
        fill: '#f0f4f8', stroke: '#dce4ea', 'stroke-width': 0.5, opacity: '0.9'
      });
      svg += '</path>';

      // 奥の雪壁（小さく）
      svg += svgElOpen('path', {
        d: 'M0,' + (roadTopY + 30)
          + ' L0,' + (roadTopY + 10)
          + ' L' + (roadLeftTop - 10) + ',' + (roadTopY + 20)
          + ' L' + (roadLeftTop) + ',' + (roadTopY + 30) + ' Z',
        fill: '#e8edf2', opacity: '0.7'
      });
      svg += '</path>';
      svg += svgElOpen('path', {
        d: 'M' + W + ',' + (roadTopY + 30)
          + ' L' + W + ',' + (roadTopY + 10)
          + ' L' + (roadRightTop + 10) + ',' + (roadTopY + 20)
          + ' L' + (roadRightTop) + ',' + (roadTopY + 30) + ' Z',
        fill: '#e8edf2', opacity: '0.7'
      });
      svg += '</path>';
    }

    // Layer 4: 車線表示（乾燥・湿潤のみ）
    if (level === 'clear' || level === 'caution') {
      // 中央線
      var segments = 6;
      for (var i = 0; i < segments; i++) {
        var t1 = 0.2 + (i / segments) * 0.7;
        var t2 = t1 + 0.04;
        var x1 = VP_X;
        var y1 = roadTopY + (roadBottom - roadTopY) * t1;
        var x2 = VP_X;
        var y2 = roadTopY + (roadBottom - roadTopY) * t2;
        var lineW = 1 + t1 * 2;
        svg += svgEl('line', {
          x1: x1, y1: y1, x2: x2, y2: y2,
          stroke: '#f1c40f', 'stroke-width': lineW, opacity: level === 'clear' ? '0.8' : '0.4'
        });
      }

      // 路肩白線（左）
      for (var i = 0; i < segments; i++) {
        var t1 = 0.2 + (i / segments) * 0.7;
        var t2 = t1 + 0.04;
        var lx1 = roadLeftTop + (roadLeftBottom - roadLeftTop) * t1 + 5;
        var ly1 = roadTopY + (roadBottom - roadTopY) * t1;
        var lx2 = roadLeftTop + (roadLeftBottom - roadLeftTop) * t2 + 5;
        var ly2 = roadTopY + (roadBottom - roadTopY) * t2;
        svg += svgEl('line', {
          x1: lx1, y1: ly1, x2: lx2, y2: ly2,
          stroke: '#fff', 'stroke-width': 1 + t1, opacity: '0.6'
        });
      }
    }

    // Layer 5: 危険表示
    if (level === 'danger' || level === 'warning') {
      // わだち線
      for (var side = -1; side <= 1; side += 2) {
        var offset = side * 25;
        svg += svgElOpen('path', {
          d: 'M' + (VP_X + offset * 0.3) + ',' + (roadTopY + 30)
            + ' Q' + (VP_X + offset * 0.6) + ',' + (H * 0.65)
            + ' ' + (VP_X + offset) + ',' + roadBottom,
          fill: 'none', stroke: 'rgba(0,0,0,0.15)', 'stroke-width': 2 + Math.abs(offset) * 0.05,
          'stroke-dasharray': '4,6'
        });
        svg += '</path>';
      }
    }

    if (level === 'critical') {
      // スタック車シルエット
      var carY = H * 0.65;
      var carW = 32;
      var carH = 14;
      var carX = VP_X - carW / 2 + 5;

      // 車体
      svg += svgElOpen('rect', {
        x: carX, y: carY, width: carW, height: carH,
        rx: 3, fill: '#c0392b', opacity: '0.7'
      });
      svg += '</rect>';
      // 窓
      svg += svgElOpen('rect', {
        x: carX + 6, y: carY + 2, width: 10, height: 6,
        rx: 1, fill: '#85c1e9', opacity: '0.6'
      });
      svg += '</rect>';
      // タイヤ
      svg += svgEl('circle', { cx: carX + 7, cy: carY + carH, r: 3, fill: '#2c3e50', opacity: '0.7' });
      svg += svgEl('circle', { cx: carX + carW - 7, cy: carY + carH, r: 3, fill: '#2c3e50', opacity: '0.7' });

      // 警告マーク
      svg += svgElOpen('text', {
        x: carX + carW + 8, y: carY + 5,
        'font-size': '14', fill: '#c0392b', 'font-weight': 'bold', opacity: '0.8'
      });
      svg += '!!</text>';
    }

    // Layer 6: ラベルバッジ
    var badgeColor = prediction.color || '#27ae60';
    var badgeLabel = prediction.label || '良好';
    var badgeW = badgeLabel.length * 14 + 16;
    svg += svgElOpen('rect', {
      x: W - badgeW - 8, y: 8, width: badgeW, height: 24,
      rx: 12, fill: badgeColor, opacity: '0.9'
    });
    svg += '</rect>';
    svg += svgElOpen('text', {
      x: W - badgeW / 2 - 8, y: 25,
      'font-size': '12', fill: '#fff', 'font-weight': 'bold', 'text-anchor': 'middle'
    });
    svg += badgeLabel + '</text>';

    svg += '</svg>';
    return svg;
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
