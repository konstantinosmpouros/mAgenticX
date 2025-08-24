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
│   ├── utils/           # Reusable UI components
|   |── layouts/         # The main parts of the chat interface
│   └── ChatInterface.tsx  # Main chat interface
├── hooks/           # Custom React hooks
├── lib/             # Utility functions
└── pages/           # Application pages
```

### Design System
The application uses a comprehensive design system with:
- Semantic color tokens for consistent theming
- Custom animations and transitions
- Responsive design patterns
- Dark/light mode support

## 💡 Future Enhancements

- Voice input/output capabilities
- Multi-language support
- Advanced file processing
- Custom agent creation
- Integration with external APIs
- Team collaboration features
