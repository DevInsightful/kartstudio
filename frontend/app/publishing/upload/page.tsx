import Link from "next/link";

export default function UploadPage() {
  return <div className="section-page">
    <section className="section-intro">
      <p className="eyebrow">PUBLISHING · UPLOAD</p>
      <p>Choose where you want to upload Reels. Use the Professional Dashboard Content Library for single or bulk uploads, or continue with the existing Page posting flow.</p>
    </section>
    <section className="professional-upload-destinations" aria-label="Choose an upload destination">
      <Link className="professional-upload-destination" href="/publishing/upload/professional-dashboard">
        <span className="professional-upload-destination-icon" aria-hidden="true">PD</span>
        <span><strong>Professional Dashboard</strong><small>Open Facebook Content Library to upload one Reel or bulk upload multiple Reels.</small></span>
        <span className="professional-upload-arrow" aria-hidden="true">›</span>
      </Link>
      <Link className="professional-upload-destination" href="/publishing/reels">
        <span className="professional-upload-destination-icon" aria-hidden="true">PG</span>
        <span><strong>Page</strong><small>Use the existing Page-based Reel posting workflow.</small></span>
        <span className="professional-upload-arrow" aria-hidden="true">›</span>
      </Link>
    </section>
  </div>;
}
