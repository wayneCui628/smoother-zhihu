'use strict';

const previewWidget = ZhihuSmootherPageWidget.createPageWidget({ document });
// The page receipt opens compactly on every fresh preview; use its native
// button to inspect the expanded ticket manually.
previewWidget.setExpanded(false);
previewWidget.update(
  { total: 35, parked: 22, live: 13, enabled: true },
  { enabled: true, showPageWidget: true, minAnswers: 12 },
);
