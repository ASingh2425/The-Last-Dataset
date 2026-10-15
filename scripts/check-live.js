const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

async function main() {
  const html = await get('https://yellow-zone-neon.vercel.app');
  console.log('HTML status:', html.status);
  const re = /src="([^"]+)"/g;
  let m;
  const scriptUrls = [];
  while ((m = re.exec(html.body)) !== null) {
    scriptUrls.push(m[1]);
  }
  console.log('Script URLs:', scriptUrls);

  for (const s of scriptUrls) {
    const fullUrl = s.startsWith('http') ? s : 'https://yellow-zone-neon.vercel.app' + s;
    const js = await get(fullUrl);
    console.log('\n--- Script:', fullUrl, 'Length:', js.body.length);
    if (js.body.includes('zone-ctf-complete')) {
      console.log('  -> Contains "zone-ctf-complete"!');
    } else {
      console.log('  -> DOES NOT contain "zone-ctf-complete"!');
    }
    if (js.body.includes('c2Jfc2VjcmV0X1hma1BER0ZhckpJbTFySFVsb0w4YndfeU1NWFJUcVU=')) {
      console.log('  -> Contains old base64 Supabase key!');
    }
    if (js.body.includes('last-dataset.vercel.app')) {
      console.log('  -> Contains "last-dataset.vercel.app"');
    }
    if (js.body.includes('bqedvdohyaeivdqzapyy')) {
      console.log('  -> Contains "bqedvdohyaeivdqzapyy"');
    }
    if (js.body.includes('MANU PROTOCOL')) {
      console.log('  -> Contains "MANU PROTOCOL"');
    }
  }
}

main().catch(console.error);
