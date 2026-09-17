import { Component, ErrorInfo, ReactNode } from "react";
import ErrorPage from "@/pages/ErrorPage";

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
  error?: Error;
};

class RootErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: undefined,
  };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the stack visible in the console for debugging/observability
    console.error("Unhandled UI error", error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return <ErrorPage error={this.state.error} onRetry={this.handleReset} />;
    }

    return this.props.children;
  }
}

export default RootErrorBoundary;
