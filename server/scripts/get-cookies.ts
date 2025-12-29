import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const account = await prisma.taobaoAccount.findFirst({
    where: { isActive: true },
    select: { id: true, name: true, cookies: true }
  });
  
  if (account && account.cookies) {
    const decoded = Buffer.from(account.cookies, 'base64').toString('utf-8');
    const cookies = JSON.parse(decoded);
    console.log('Account:', account.name);
    console.log('Cookie count:', cookies.length);
    // 输出cookies JSON供浏览器使用
    console.log('---COOKIES_START---');
    console.log(JSON.stringify(cookies));
    console.log('---COOKIES_END---');
  } else {
    console.log('No active account found');
  }
  
  await prisma.$disconnect();
}

main();
