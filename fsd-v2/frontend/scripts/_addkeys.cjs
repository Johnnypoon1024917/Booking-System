const fs = require('fs'); const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales');
const K = {
  'login.setNewPassword': {en:'Set a new password','zh-Hans':'设置新密码','zh-Hant':'設定新密碼'},
  'login.mustChangeHelp': {en:'Your administrator issued a temporary password. Choose a new one to continue.','zh-Hans':'管理员为您设置了临时密码。请设置新密码以继续。','zh-Hant':'管理員為您設定了臨時密碼。請設定新密碼以繼續。'},
  'login.newPassword': {en:'New password','zh-Hans':'新密码','zh-Hant':'新密碼'},
  'login.confirmPassword': {en:'Confirm password','zh-Hans':'确认密码','zh-Hant':'確認密碼'},
  'login.setPasswordContinue': {en:'Set password & continue','zh-Hans':'设置密码并继续','zh-Hant':'設定密碼並繼續'},
  'login.passwordsMismatch': {en:'Passwords do not match','zh-Hans':'两次输入的密码不一致','zh-Hant':'兩次輸入的密碼不一致'},
  'login.changeFailed': {en:'Could not set password','zh-Hans':'无法设置密码','zh-Hant':'無法設定密碼'},
  'adminUsers.initialPassword': {en:'Initial password','zh-Hans':'初始密码','zh-Hant':'初始密碼'},
  'adminUsers.forceReset': {en:'Require password reset on first login','zh-Hans':'首次登录时强制重设密码','zh-Hant':'首次登入時強制重設密碼'},
};
function setDeep(o, dotted, v){const p=dotted.split('.');let c=o;for(let i=0;i<p.length-1;i++){if(typeof c[p[i]]!=='object'||c[p[i]]===null)c[p[i]]={};c=c[p[i]];}if(!(p[p.length-1] in c))c[p[p.length-1]]=v;}
for (const loc of ['en','zh-Hans','zh-Hant']){const f=path.join(dir,`${loc}.json`);const d=JSON.parse(fs.readFileSync(f,'utf8'));for(const[k,tr]of Object.entries(K))setDeep(d,k,tr[loc]);fs.writeFileSync(f,JSON.stringify(d,null,2)+'\n','utf8');console.log(loc,'ok');}
