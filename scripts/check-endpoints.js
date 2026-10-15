const cp = require('child_process');
const content = cp.execSync('git show 5ee357c:lib/hub.js').toString();
console.log('Includes /api/team-state:', content.includes("'/api/team-state'"));
console.log('Includes /api/integrations/team-state:', content.includes("'/api/integrations/team-state'"));
console.log('Includes /api/zone-ctf-complete:', content.includes("'/api/zone-ctf-complete'"));
console.log('Includes /api/integrations/zone-ctf-complete:', content.includes("'/api/integrations/zone-ctf-complete'"));
console.log('Includes /api/zone/status:', content.includes("'/api/zone/status'"));
