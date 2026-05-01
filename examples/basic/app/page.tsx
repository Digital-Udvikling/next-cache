export default function Home() {
  return (
    <main>
      <h1>@aortl/next-cache example</h1>
      <ul>
        <li>
          <a href="/cached">/cached — uses 'use cache'</a>
        </li>
        <li>
          <a href="/cached-remote">/cached-remote — uses 'use cache: remote'</a>
        </li>
      </ul>
    </main>
  );
}
