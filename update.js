module.exports = {
  run: [
    {
      method: "shell.run",
      params: {
        path: "app",
        env: {
          VITE_EUPHONY_FRONTEND_ONLY: "true"
        },
        message: [
          "git pull",
          "npm install",
          "npx tsc",
          "npx vite build --mode github"
        ]
      }
    }
  ]
}
