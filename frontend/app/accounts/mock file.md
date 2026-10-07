
mkdir mock-facebook-login
cd mock-facebook-login
npm init -y
npm install playwright
npx playwright install chromium

<!DOCTYPE html>
<html>
<head>
  <title>Mock Facebook Login</title>
</head>
<body>
  <h2>Facebook Login — Mock</h2>

  <form id="loginForm">
    <input id="email" type="email" placeholder="Email" />
    <input id="password" type="password" placeholder="Password" />
    <button type="submit">Log In</button>
  </form>

  <p id="result"></p>

  <script>
    document.getElementById("loginForm").addEventListener("submit", (e) => {
      e.preventDefault();

      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;

      document.getElementById("result").textContent =
        email && password ? "Login submitted" : "Missing credentials";
    });
  </script>
</body>
</html>


[
  {
    "email": "test1@example.com",
    "password": "MockPassword123"
  },
  {
    "email": "test2@example.com",
    "password": "MockPassword456"
  }
]

const { chromium } = require("playwright");
const accounts = require("./accounts.json");
const path = require("path");

(async () => {
  const browser = await chromium.launch({
    headless: false
  });

  for (const account of accounts) {
    const page = await browser.newPage();

    await page.goto(
      `file://${path.resolve("index.html")}`
    );

    // Seed mock email
    await page.locator("#email").fill(account.email);

    // Seed mock password
    await page.locator("#password").fill(account.password);

    console.log(`Seeded: ${account.email}`);

    await page.waitForTimeout(1000);

    await page.locator("button[type='submit']").click();

    await page.waitForTimeout(1000);

    await page.close();
  }

  await browser.close();
})();


node seed-login.js