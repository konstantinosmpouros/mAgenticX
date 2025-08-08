# Agentic Chatting Platform

An intelligent AI agent interaction platform built with modern web technologies. This application provides a sophisticated chat interface where users can interact with specialized AI agents across different domains.

## 🚀 Features

- **Multi-Agent Support**: Choose from specialized agents including HR Policies, Retail, Marketing, Research, and DeepResearch
- **Real-time Thinking Process**: Watch as agents analyze and process your queries with transparent thinking steps
- **File & Photo Attachments**: Upload and share files with AI agents
- **Conversation History**: Keep track of all your conversations with automatic saving
- **Responsive Design**: Beautiful, modern interface that works on all devices
- **Voice Input Support**: Future-ready voice interaction capabilities

## 🛠 Technology Stack

- **Frontend Framework**: React 18 with TypeScript
- **Build Tool**: Vite for fast development and building
- **UI Components**: shadcn/ui with Radix UI primitives
- **Styling**: Tailwind CSS with custom design system
- **State Management**: React hooks and context
- **Backend**: Supabase for data persistence and file storage
- **Icons**: Lucide React for beautiful, consistent icons

## 📦 Setup & Installation

### Prerequisites
- Node.js (v18 or higher) - [Install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)
- npm or yarn package manager

### Local Development

1. **Clone the repository**
   ```bash
   git clone <YOUR_GIT_URL>
   cd <YOUR_PROJECT_NAME>
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the development server**
   ```bash
   npm run dev
   ```

4. **Open your browser**
   Navigate to `http://localhost:8080` to see the application running.

### Available Scripts

- `npm run dev` - Start development server with hot reloading
- `npm run build` - Build the application for production
- `npm run preview` - Preview the production build locally
- `npm run lint` - Run ESLint for code quality checks

## 🎯 Project Purpose

This platform serves as a demonstration of advanced AI agent interactions, showcasing:

- **Professional Agent Communication**: Each agent is specialized for specific business domains
- **Transparent AI Processing**: Users can see the thinking process behind AI responses
- **Modern UX Patterns**: Implementing ChatGPT-like interface patterns with enhanced features
- **Scalable Architecture**: Built with modularity and extensibility in mind

## 🔧 Development

### Project Structure
```
src/
├── components/
│   ├── ui/           # Reusable UI components (shadcn/ui)
│   └── ChatInterface.tsx  # Main chat interface
├── hooks/           # Custom React hooks
├── lib/             # Utility functions
├── pages/           # Application pages
└── styles/          # Global styles and design tokens
```

### Design System
The application uses a comprehensive design system with:
- Semantic color tokens for consistent theming
- Custom animations and transitions
- Responsive design patterns
- Dark/light mode support

## 🚀 Deployment

### Using Lovable (Recommended)
1. Visit your [Lovable Project](https://lovable.dev/projects/cc13b702-4d4d-45cc-9fb2-2f04d264794d)
2. Click on "Share" → "Publish"
3. Your app will be deployed automatically

### Manual Deployment
You can deploy this application to any static hosting service:
- Vercel
- Netlify
- GitHub Pages
- AWS S3 + CloudFront

## 🔗 Links

- **Live Application**: [Lovable Project](https://lovable.dev/projects/cc13b702-4d4d-45cc-9fb2-2f04d264794d)
- **Documentation**: [Lovable Docs](https://docs.lovable.dev/)
- **Community**: [Discord](https://discord.com/channels/1119885301872070706/1280461670979993613)

## 📝 License

This project is built with Lovable and follows their terms of service.

## 🤝 Contributing

This project is primarily developed through the Lovable platform. To contribute:

1. Use the Lovable editor for changes
2. Or clone locally and push changes to sync with Lovable
3. All changes made via Lovable are automatically committed

## 💡 Future Enhancements

- Voice input/output capabilities
- Multi-language support
- Advanced file processing
- Custom agent creation
- Integration with external APIs
- Team collaboration features