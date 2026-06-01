// Dark-mode-only build. The toggle has been removed; this file now only
// ships the no-flash script that locks <html> into dark mode on first paint.
export const THEME_NOFLASH_SCRIPT = `
(function(){try{
  var r=document.documentElement;
  r.classList.add('dark');
  r.style.colorScheme='dark';
}catch(e){}})();
`;
