#!/usr/bin/env node
// jira-format.mjs — standard grayboard Jira ticket format -> ADF
// usage: jira-format.mjs <spec.json> [out.adf.json]
// spec: {tldr: {problem[], value[], solution[]}, details[]?, acceptance[]?, tracking: [{label, href}]?}
import fs from 'fs';

try {
  const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const text = (t, marks) => {
    const node = {type: 'text', text: t};
    if (marks) node.marks = marks;
    return node;
  };
  const h = (level, t) => ({type: 'heading', attrs: {level}, content: [text(t)]});
  const bulletNode = (item) => {
    let content;
    if (typeof item === 'object' && item.href) {
      content = [{type: 'text', text: item.label + ': '}, {type: 'text', text: item.href, marks: [{type: 'link', attrs: {href: item.href}}]}];
    } else if (typeof item === 'string') {
      content = [text(item)];
    } else {
      content = [text(JSON.stringify(item))];
    }
    return {type: 'listItem', content: [{type: 'paragraph', content}]};
  };
  const bullets = (items) => ({type: 'bulletList', content: (items || []).map(bulletNode)});
  const tldrPanel = (t) => {
    const s = t || {};
    return {type: 'panel', attrs: {panelType: 'info'}, content: [h(3, 'PROBLEM'), bullets(s.problem), h(3, 'VALUE'), bullets(s.value), h(3, 'SOLUTION'), bullets(s.solution)]};
  };
  const buildAdf = (spec) => {
    const s = spec || {};
    const content = [tldrPanel(s.tldr || s)];
    if (s.details?.length) content.push(h(2, 'Details'), bullets(s.details));
    if (s.acceptance?.length) content.push(h(2, 'Acceptance criteria'), bullets(s.acceptance));
    if (s.tracking?.length) content.push(h(2, 'Tracking'), bullets(s.tracking));
    return {type: 'doc', version: 1, content};
  };
  const adf = buildAdf(spec.tldr ? spec : {tldr: spec});
  const out = process.argv[3] || 'ticket.adf.json';
  fs.writeFileSync(out, JSON.stringify(adf, null, 1));
  console.log('ADF written:', out);
} catch (err) {
  console.error('jira-format:', err.message);
  process.exit(1);
}
