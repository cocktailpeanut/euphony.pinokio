module.exports = {
  run: [
    {
      when: "{{!exists('app')}}",
      method: "shell.run",
      params: {
        message: [
          "git clone https://github.com/openai/euphony app"
        ]
      }
    },
    {
      method: "shell.run",
      params: {
        path: "app",
        env: {
          VITE_EUPHONY_FRONTEND_ONLY: "true"
        },
        message: [
          "npm install",
          "npx tsc",
          "npx vite build --mode github"
        ]
      }
    }
  ]
}
