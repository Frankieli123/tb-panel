import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function getAccount() {
  const account = await prisma.taobaoAccount.findFirst({
    where: { isActive: true }
  });

  if (account) {
    console.log('Account ID:', account.id);
    console.log('Account Name:', account.name);
    console.log('Has Cookies:', !!account.cookies);
    console.log('Cookies length:', account.cookies?.length || 0);
  } else {
    console.log('No active account found');
  }

  await prisma.$disconnect();
}

getAccount();
