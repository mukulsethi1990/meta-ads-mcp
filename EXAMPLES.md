# Practical Examples for Campaign Management

## 1. Campaign Creation
### Example: Creating a Campaign
```python
import requests

url = 'https://api.example.com/campaigns'
headers = {'Authorization': 'Bearer YOUR_ACCESS_TOKEN'}
data = {
    'name': 'Spring Sale Campaign',
    'objective': 'LINK_CLICKS',
    'budget': 1000
}

response = requests.post(url, json=data, headers=headers)
print(response.json())
```

## 2. Ad Set Management
### Example: Managing Ad Sets
```python
url = 'https://api.example.com/adsets'
data = {
    'campaign_id': 'CAMPAIGN_ID_HERE',
    'name': 'Ad Set 1',
    'targeting': {'geo_locations': {'countries': ['US']}},
    'daily_budget': 500
}

response = requests.post(url, json=data, headers=headers)
print(response.json())
```

## 3. Targeting
### Example: Setting Target Audience
```python
url = 'https://api.example.com/targeting'
data = {
    'age_min': 18,
    'age_max': 35,
    'interests': ['sports', 'tech']
}

response = requests.post(url, json=data, headers=headers)
print(response.json())
```

## 4. Analytics
### Example: Fetching Analytics
```python
url = 'https://api.example.com/analytics'
id = 'CAMPAIGN_ID_HERE'

response = requests.get(f'{url}/{id}', headers=headers)
print(response.json())
```

## 5. Error Handling
### Example: Handling Errors
```python
response = requests.post(url, json=data, headers=headers)
if response.status_code != 200:
    print('Error:', response.json()['message'])
else:
    print('Success:', response.json())
```

## Conclusion
These examples illustrate the basic functionalities for managing campaigns and ad sets, targeting specific audiences, analyzing performance, and handling errors.