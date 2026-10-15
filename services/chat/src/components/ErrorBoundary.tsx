import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

/** Last-resort fallback for rendering errors (no details are logged: they could contain message text). */
export class ErrorBoundary extends Component<{ children: ReactNode; compact?: boolean }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally not logging the error object.
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={this.props.compact ? "empty-pane" : "boot"}>
        <div className="empty-card" role="alert">
          <TriangleAlert aria-hidden="true" className="empty-icon" />
          <h1>Something went wrong</h1>
          <p className="muted">This part of the app hit an unexpected problem. Your messages and keys are safe.</p>
          <div className="cluster center-cluster">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            {this.props.compact ? (
              <button type="button" className="btn" onClick={() => this.setState({ failed: false })}>
                Try again
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
}
